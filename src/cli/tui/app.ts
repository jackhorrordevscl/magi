import type { Widgets } from 'blessed';
import type { Evaluator as EvaluatorName } from '../../gating/consensus.ts';
import type { EvaluatorsConfig, EvaluatorSettings } from '../../gating/evaluator-config.ts';
import { EvaluatorBackendSchema, EvaluatorsConfigSchema } from '../../gating/evaluator-config.ts';
import { normalizeEvaluators, readConfigFile, writeEvaluatorsSection } from './config-file.ts';
import type { ConfigFileRead } from './config-file.ts';
import { effectiveSettings } from './effective-settings.ts';
import type { EffectiveSettings } from './effective-settings.ts';
import { validateFieldEdit } from './field-edit.ts';
import type { FieldName } from './field-edit.ts';
import { auditSummary, deniedRecords, deniedRecordsFooter } from './audit-view.ts';
import type { DeniedRecordRow } from './audit-view.ts';
import { readChainRecords } from '../../audit/read-chain.ts';
import type { AuditRecord } from '../../audit/record.ts';

/**
 * The `magi tui` screen — the only file in this change that touches
 * `blessed` (design decisions 1, 3-9). `blessed` is imported with a
 * dynamic `await import('blessed')` **inside `runTui()`**, never as a
 * module-top static import: `esbuild.config.mjs`'s `external: ['blessed']`
 * keeps it out of `dist/magi.mjs`'s bundle, and this lazy call site keeps
 * it from ever loading for any `magi` invocation other than `magi tui`
 * (see Key Learning 3 in `openspec/changes/magi-evaluator-config-tui/
 * tasks.md`). `import type { Widgets } from 'blessed'` above is safe
 * alongside that rule — type-only imports are fully erased by both `tsc`
 * and esbuild (`verbatimModuleSyntax`), so they never become a runtime
 * `require`/`import` of the package.
 *
 * Structurally impossible fields (task 3.8): no widget, key map, or write
 * path anywhere in this file ever references `apiKey`, `baseUrl`, `mode`,
 * `tiers`, or any `paths` entry. The only fields ever read from or written
 * to `pending`/`saved` are `backend`/`model`/`timeoutMs`/`maxTokens`, via
 * `FIELD_NAMES` below and `writeEvaluatorsSection` (Slice 1), which itself
 * only ever emits those four fields (`normalizeEvaluators`).
 */

export interface RunTuiOptions {
  configPath: string;
  auditDir: string;
}

const EVALUATOR_NAMES: readonly EvaluatorName[] = ['melchior', 'balthasar', 'casper'];
const FIELD_NAMES: readonly FieldName[] = ['backend', 'model', 'timeoutMs', 'maxTokens'];
const FIRST_EVALUATOR: EvaluatorName = 'melchior';
const FIRST_FIELD: FieldName = 'backend';

const HELP_TEXT = [
  'Global',
  '  Tab / 1 / 2   switch Evaluators / Audit',
  '  s             save (refused when the config file is missing/unparseable)',
  '  r             discard pending changes, reload from disk',
  '  ?             toggle this help',
  '  q / C-c       quit (confirms when there are unsaved changes)',
  '',
  'Evaluators',
  '  up/down, j/k  move field cursor',
  '  left/right, h/l  switch evaluator',
  '  enter         edit the selected field',
  '  esc           cancel an in-progress edit',
  '  d             clear the selected field (unset -> default)',
  '',
  'Audit',
  '  up/down, PgUp/PgDn  scroll the denied-records list',
  '  enter         open a read-only detail view (actor, action, votes)',
  '  esc           close the detail view / this help',
].join('\n');

/**
 * Pure, `blessed`-free helpers — kept testable without a tty (see
 * `tests/cli/tui/app.test.ts`). Everything below this point that touches a
 * widget lives inside `runTui()`.
 */

export function fieldValueText(field: FieldName, entry: EvaluatorSettings, effective: EffectiveSettings): string {
  const value = effective[field].value;
  return entry[field] !== undefined ? String(value) : `(default: ${value})`;
}

export function clearField(entry: EvaluatorSettings, field: FieldName): EvaluatorSettings {
  const next: EvaluatorSettings = { ...entry };
  delete next[field];
  return next;
}

/** Compares through `normalizeEvaluators` (Slice 1) so "both empty" always compares equal, regardless of representation. */
export function pendingHasUnsavedChanges(pending: EvaluatorsConfig, saved: EvaluatorsConfig): boolean {
  return JSON.stringify(normalizeEvaluators(pending) ?? {}) !== JSON.stringify(normalizeEvaluators(saved) ?? {});
}

export function deniedRowLabel(row: DeniedRecordRow): string {
  return `${row.seq} · ${row.timestamp} · ${row.severity} · ${row.hash.slice(0, 11)}`;
}

function fieldRowLabel(field: FieldName, entry: EvaluatorSettings, effective: EffectiveSettings): string {
  const text = fieldValueText(field, entry, effective);
  const label = field.padEnd(10);
  return entry[field] === undefined ? `${label} {grey-fg}${text}{/grey-fg}` : `${label} ${text}`;
}

/**
 * Runs the interactive `magi tui` screen until the operator quits.
 * Resolves with a process exit code (`0`).
 */
export async function runTui(options: RunTuiOptions): Promise<number> {
  const { configPath, auditDir } = options;
  const mod = await import('blessed');
  const blessed = mod.default ?? mod;

  function loadFromDisk(): { config: ConfigFileRead; evaluators: EvaluatorsConfig } {
    const config = readConfigFile(configPath);
    const rawEvaluators = config.status === 'ok' ? config.raw.evaluators : undefined;
    return { config, evaluators: EvaluatorsConfigSchema.parse(rawEvaluators) };
  }

  const initial = loadFromDisk();
  let config = initial.config;
  let saved = initial.evaluators;
  let pending: EvaluatorsConfig = structuredClone(saved);

  let evaluatorIndex = 0;
  let fieldIndex = 0;
  let tab: 'evaluators' | 'audit' = 'evaluators';
  let editing = false;
  let statusMessage =
    config.status === 'missing'
      ? `${configPath} not found — showing built-in defaults, save disabled`
      : config.status === 'unparseable'
        ? `${configPath} is not valid JSON (${config.message}) — showing defaults until fixed`
        : '';

  let auditLoaded = false;
  let auditRows: DeniedRecordRow[] = [];
  let auditDetailByHash = new Map<string, AuditRecord>();

  const screen: Widgets.Screen = blessed.screen({ smartCSR: true, title: 'MAGI — evaluator config' });

  const headerBox: Widgets.BoxElement = blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: 1, tags: true });

  const evaluatorsContainer: Widgets.BoxElement = blessed.box({
    parent: screen,
    top: 1,
    left: 0,
    width: '100%',
    height: '100%-4',
  });
  const evaluatorListBox: Widgets.ListElement = blessed.list({
    parent: evaluatorsContainer,
    label: ' Evaluators ',
    border: 'line',
    top: 0,
    left: 0,
    width: '30%',
    height: '100%',
    tags: true,
    items: [...EVALUATOR_NAMES],
    style: { selected: { inverse: true } },
  });
  const fieldsListBox: Widgets.ListElement = blessed.list({
    parent: evaluatorsContainer,
    border: 'line',
    top: 0,
    left: '30%',
    width: '70%',
    height: '100%',
    tags: true,
    items: [],
    style: { selected: { inverse: true } },
  });

  const auditContainer: Widgets.BoxElement = blessed.box({
    parent: screen,
    top: 1,
    left: 0,
    width: '100%',
    height: '100%-4',
  });
  auditContainer.hide();
  const summaryBox: Widgets.BoxElement = blessed.box({
    parent: auditContainer,
    label: ' Audit Summary ',
    border: 'line',
    top: 0,
    left: 0,
    width: '100%',
    height: 8,
    tags: true,
  });
  const deniedListBox: Widgets.ListElement = blessed.list({
    parent: auditContainer,
    label: ' Denied Records ',
    border: 'line',
    top: 8,
    left: 0,
    width: '100%',
    height: '100%-8',
    tags: true,
    keys: true,
    items: [],
    style: { selected: { inverse: true } },
  });

  const statusBox: Widgets.BoxElement = blessed.box({ parent: screen, bottom: 1, left: 0, width: '100%', height: 1, tags: true });
  blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    content: '{grey-fg}↑↓ field  ⏎ edit  d clear  s save  r reload  ⇥/1/2 tab  ? help  q quit{/grey-fg}',
  });
  const helpOverlay: Widgets.BoxElement = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: '70%',
    border: 'line',
    label: ' Help ',
    tags: true,
    content: HELP_TEXT,
  });
  helpOverlay.hide();
  const detailBox: Widgets.BoxElement = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: '60%',
    border: 'line',
    label: ' Record Detail ',
    tags: true,
  });
  detailBox.hide();
  let confirmBox: Widgets.BoxElement | undefined;

  function renderHeader(): void {
    const label = tab === 'evaluators' ? 'Evaluators' : 'Audit';
    headerBox.setContent(` MAGI — ${configPath}   [ ${label} ]`);
  }

  function renderStatus(): void {
    const dirty = pendingHasUnsavedChanges(pending, saved) ? 'unsaved changes' : 'no pending changes';
    const savePart = config.status === 'missing' ? ' — save disabled (no config file)' : '';
    const messagePart = statusMessage ? ` — ${statusMessage}` : '';
    statusBox.setContent(`status: ${dirty}${savePart}${messagePart}`);
  }

  function renderEvaluatorsScreen(): void {
    const name = EVALUATOR_NAMES[evaluatorIndex] ?? FIRST_EVALUATOR;
    const entry = pending[name] ?? {};
    const effective = effectiveSettings(name, entry);
    fieldsListBox.setLabel(` ${name} `);
    fieldsListBox.setItems(FIELD_NAMES.map((field) => fieldRowLabel(field, entry, effective)));
    fieldsListBox.select(fieldIndex);
    evaluatorListBox.select(evaluatorIndex);
    renderHeader();
    renderStatus();
    screen.render();
  }

  function loadAuditTabOnce(): void {
    if (auditLoaded) return;
    const summary = auditSummary(auditDir);
    const denied = deniedRecords(auditDir);
    auditRows = denied.rows;
    const footer = deniedRecordsFooter(denied);
    auditDetailByHash = new Map(
      readChainRecords(auditDir)
        .filter((record): record is AuditRecord => 'decision' in record && record.decision === 'deny')
        .map((record) => [record.hash, record]),
    );
    summaryBox.setContent(summary.lines.join('\n'));
    deniedListBox.setLabel(footer ? ` Denied Records — ${footer} ` : ' Denied Records ');
    deniedListBox.setItems(auditRows.map((row) => deniedRowLabel(row)));
    auditLoaded = true;
  }

  function renderAuditScreen(): void {
    loadAuditTabOnce();
    renderHeader();
    renderStatus();
    screen.render();
  }

  function switchTab(next: 'evaluators' | 'audit'): void {
    tab = next;
    if (next === 'evaluators') {
      auditContainer.hide();
      evaluatorsContainer.show();
      renderEvaluatorsScreen();
      fieldsListBox.focus();
    } else {
      evaluatorsContainer.hide();
      auditContainer.show();
      renderAuditScreen();
      deniedListBox.focus();
    }
  }

  function doSave(): void {
    if (editing) return;
    if (config.status === 'missing') {
      statusMessage = `save disabled — ${configPath} does not exist`;
      renderStatus();
      screen.render();
      return;
    }
    const result = writeEvaluatorsSection(configPath, pending);
    if (!result.ok) {
      statusMessage = `save failed: ${result.message}`;
      renderStatus();
      screen.render();
      return;
    }
    const reloaded = loadFromDisk();
    config = reloaded.config;
    saved = reloaded.evaluators;
    pending = structuredClone(saved);
    statusMessage = 'saved';
    renderEvaluatorsScreen();
  }

  function doReload(): void {
    if (editing) return;
    const reloaded = loadFromDisk();
    config = reloaded.config;
    saved = reloaded.evaluators;
    pending = structuredClone(saved);
    statusMessage = 'reloaded from disk';
    renderEvaluatorsScreen();
  }

  function closeOverlay(el: Widgets.BlessedElement): void {
    el.destroy();
    editing = false;
    fieldsListBox.focus();
    renderEvaluatorsScreen();
  }

  function openBackendPicker(name: EvaluatorName, field: FieldName, entry: EvaluatorSettings): void {
    const options: string[] = [...EvaluatorBackendSchema.options];
    const picker: Widgets.ListElement = blessed.list({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 26,
      height: options.length + 2,
      border: 'line',
      label: ' backend ',
      tags: true,
      keys: true,
      items: options,
      style: { selected: { inverse: true } },
    });
    picker.focus();
    screen.render();
    picker.key(['escape'], () => closeOverlay(picker));
    picker.on('select', (_item, index) => {
      const raw = options[index] ?? '';
      const result = validateFieldEdit(name, field, raw, entry);
      if (result.ok) {
        pending[name] = result.entry;
        statusMessage = `${name}.${field} updated (pending — press s to save)`;
      } else {
        statusMessage = result.message;
      }
      closeOverlay(picker);
    });
  }

  function openTextEditor(name: EvaluatorName, field: FieldName, entry: EvaluatorSettings): void {
    const initialValue = entry[field] !== undefined ? String(entry[field]) : '';
    const wrapper: Widgets.BoxElement = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 46,
      height: 5,
      border: 'line',
      label: ` ${name}.${field} `,
      tags: true,
    });
    const errorLine: Widgets.BoxElement = blessed.box({
      parent: wrapper,
      top: 2,
      left: 1,
      width: '100%-2',
      height: 2,
      tags: true,
    });
    const input: Widgets.TextboxElement = blessed.textbox({
      parent: wrapper,
      top: 0,
      left: 1,
      width: '100%-2',
      height: 1,
      keys: true,
      inputOnFocus: true,
    });
    input.setValue(initialValue);
    screen.render();

    const ask = (): void => {
      input.readInput((_err, value) => {
        if (value == null) {
          closeOverlay(wrapper);
          return;
        }
        const result = validateFieldEdit(name, field, value, entry);
        if (!result.ok) {
          errorLine.setContent(`{red-fg}${result.message}{/red-fg}`);
          input.setValue('');
          screen.render();
          ask();
          return;
        }
        pending[name] = result.entry;
        statusMessage = `${name}.${field} updated (pending — press s to save)`;
        closeOverlay(wrapper);
      });
    };
    ask();
  }

  function openEditor(): void {
    if (editing) return;
    editing = true;
    const name = EVALUATOR_NAMES[evaluatorIndex] ?? FIRST_EVALUATOR;
    const field = FIELD_NAMES[fieldIndex] ?? FIRST_FIELD;
    const entry = pending[name] ?? {};
    if (field === 'backend') openBackendPicker(name, field, entry);
    else openTextEditor(name, field, entry);
  }

  function clearSelectedField(): void {
    if (editing) return;
    const name = EVALUATOR_NAMES[evaluatorIndex] ?? FIRST_EVALUATOR;
    const field = FIELD_NAMES[fieldIndex] ?? FIRST_FIELD;
    const entry = pending[name] ?? {};
    pending[name] = clearField(entry, field);
    statusMessage = `${name}.${field} cleared (pending — press s to save)`;
    renderEvaluatorsScreen();
  }

  function openDetail(index: number): void {
    const row = auditRows[index];
    if (!row) return;
    const record = auditDetailByHash.get(row.hash);
    const lines = record
      ? [
          `actor: ${record.actor}`,
          `action: ${record.action}`,
          `votes: ${record.votes.map((vote) => `${vote.evaluator}=${vote.vote}`).join(', ')}`,
        ]
      : ['record detail unavailable'];
    detailBox.setContent(lines.join('\n'));
    detailBox.show();
    screen.render();
  }

  return new Promise<number>((resolve) => {
    function quit(code: number): void {
      screen.destroy();
      resolve(code);
    }

    function requestQuit(): void {
      if (editing || confirmBox) return;
      if (!pendingHasUnsavedChanges(pending, saved)) {
        quit(0);
        return;
      }
      confirmBox = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 44,
        height: 4,
        border: 'line',
        label: ' Confirm ',
        tags: true,
        content: 'Unsaved changes — quit anyway? (y/n)',
      });
      screen.render();
    }

    screen.key(['tab', '1'], () => {
      if (!editing) switchTab('evaluators');
    });
    screen.key(['2'], () => {
      if (!editing) switchTab('audit');
    });
    screen.key(['s'], () => {
      if (tab === 'evaluators') doSave();
    });
    screen.key(['r'], () => {
      if (tab === 'evaluators') doReload();
    });
    screen.key(['?'], () => {
      if (helpOverlay.hidden) helpOverlay.show();
      else helpOverlay.hide();
      screen.render();
    });
    screen.key(['q', 'C-c'], requestQuit);
    screen.key(['y'], () => {
      if (!confirmBox) return;
      confirmBox.destroy();
      confirmBox = undefined;
      quit(0);
    });
    screen.key(['n'], () => {
      if (!confirmBox) return;
      confirmBox.destroy();
      confirmBox = undefined;
      screen.render();
    });
    screen.key(['escape'], () => {
      if (confirmBox) {
        confirmBox.destroy();
        confirmBox = undefined;
        screen.render();
        return;
      }
      if (!helpOverlay.hidden) {
        helpOverlay.hide();
        screen.render();
        return;
      }
      if (!detailBox.hidden) {
        detailBox.hide();
        screen.render();
      }
    });

    fieldsListBox.key(['up', 'k'], () => {
      if (editing) return;
      fieldIndex = (fieldIndex + FIELD_NAMES.length - 1) % FIELD_NAMES.length;
      renderEvaluatorsScreen();
    });
    fieldsListBox.key(['down', 'j'], () => {
      if (editing) return;
      fieldIndex = (fieldIndex + 1) % FIELD_NAMES.length;
      renderEvaluatorsScreen();
    });
    fieldsListBox.key(['left', 'h'], () => {
      if (editing) return;
      evaluatorIndex = (evaluatorIndex + EVALUATOR_NAMES.length - 1) % EVALUATOR_NAMES.length;
      renderEvaluatorsScreen();
    });
    fieldsListBox.key(['right', 'l'], () => {
      if (editing) return;
      evaluatorIndex = (evaluatorIndex + 1) % EVALUATOR_NAMES.length;
      renderEvaluatorsScreen();
    });
    fieldsListBox.key(['enter'], openEditor);
    fieldsListBox.key(['d'], clearSelectedField);

    deniedListBox.key(['pageup'], () => {
      deniedListBox.move(-(deniedListBox.height as number));
      screen.render();
    });
    deniedListBox.key(['pagedown'], () => {
      deniedListBox.move(deniedListBox.height as number);
      screen.render();
    });
    deniedListBox.on('select', (_item, index) => openDetail(index));

    switchTab('evaluators');
  });
}
