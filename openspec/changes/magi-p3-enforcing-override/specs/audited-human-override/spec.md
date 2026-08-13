# Audited Human Override Specification

## Purpose

Defines the `magi audit override` CLI: how an operator documents that a previously recorded deny should be disregarded, without ever mutating the tamper-evident audit chain and without granting any automatic allowlist or retry effect.

## Requirements

### Requirement: Override Targets a Record By Hash

The override CLI MUST identify the target audit record by its content `hash`, not by `seq`.

#### Scenario: Override by valid hash

- GIVEN an audit chain contains a record with hash `abc123`
- WHEN the operator runs `magi audit override abc123 --reason "..."`
- THEN the CLI resolves the target record by matching `hash === "abc123"`

#### Scenario: Override with unknown hash

- GIVEN no audit record has hash `doesnotexist`
- WHEN the operator runs `magi audit override doesnotexist --reason "..."`
- THEN the CLI errors out and writes no new record

### Requirement: Reason Is Mandatory

The override CLI MUST require a non-empty `--reason` argument and MUST refuse to run without one.

#### Scenario: Missing reason

- GIVEN a valid target hash
- WHEN the operator runs `magi audit override <hash>` without `--reason`
- THEN the CLI errors out and writes no new record

#### Scenario: Empty reason

- GIVEN a valid target hash
- WHEN the operator runs `magi audit override <hash> --reason ""`
- THEN the CLI errors out and writes no new record

#### Scenario: Valid reason persisted

- GIVEN a valid target hash and `--reason "operator verified manually"`
- WHEN the override succeeds
- THEN the appended override record includes that reason text

### Requirement: Only Deny Records Are Overridable

The override CLI MUST validate that the target record's `decision` is `deny`. If the target record's decision is `allow`, the CLI MUST error out and write nothing.

#### Scenario: Overriding a deny record

- GIVEN the target record has `decision: 'deny'`
- WHEN the operator runs a valid override command
- THEN the CLI appends a new override record referencing the target

#### Scenario: Overriding an allow record is rejected

- GIVEN the target record has `decision: 'allow'`
- WHEN the operator runs `magi audit override <hash> --reason "..."`
- THEN the CLI errors out and writes no new record

### Requirement: Override Is Append-Only and Non-Mutating

The system MUST record an override as a new hash-chained record appended to the audit log. The system MUST NOT mutate the original denied record's bytes, hash, or any downstream record in the chain.

#### Scenario: Original record unchanged after override

- GIVEN a denied record exists in the chain
- WHEN an operator successfully overrides it
- THEN the original record's bytes and hash are unchanged
- AND `magi audit verify` still passes for the full chain

#### Scenario: Override record links to the original

- GIVEN a denied record with hash `abc123`
- WHEN the override is appended
- THEN the new record references `abc123` (the overridden record) in its own content

### Requirement: Override Is Documentary Only

An override record MUST NOT create any allowlist entry and MUST NOT trigger an automatic retry of the original action. The blocked action only proceeds if the operator separately re-attempts it (e.g. after switching to shadow mode, or once the blocking condition is resolved).

#### Scenario: Override does not re-run the action

- GIVEN an operator overrides a denied record
- WHEN the override command completes
- THEN no tool call is re-executed and no allowlist entry is created as a side effect

### Requirement: Deny-Rate Accounting Unaffected By Override

`magi audit stats`' deny-rate metric MUST continue to classify the original denied record as a deny. An override MUST NOT reclassify it as allowed.

#### Scenario: Deny rate includes overridden deny

- GIVEN a denied record was later overridden
- WHEN `magi audit stats` computes the deny rate
- THEN the original record still counts toward the deny split

### Requirement: Override Count Reported Separately

`magi audit stats` MUST report override count/rate as a metric distinct from the allow/deny decision split.

#### Scenario: Stats show override count

- GIVEN the audit log contains 5 deny records and 2 override records
- WHEN the operator runs `magi audit stats`
- THEN the output reports 5 denies in the decision split and 2 overrides as a separate metric
