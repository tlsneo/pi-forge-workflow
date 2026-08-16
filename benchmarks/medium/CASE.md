# Medium Case — Optional Request Timeout Contract

## Baseline

The fixture has an existing three-node data flow:

```text
createConfig(overrides)
→ createRequestPolicy(config)
→ createClient(config).describeRequest(path)
→ observable request descriptor
```

The existing public behavior is:

```js
createClient(createConfig()).describeRequest("/users")
// { path: "/users", retries: 2 }
```

## Requirement

Add an optional request-timeout contract across the existing configuration, request-policy, and client Modules.

### Supported behavior

1. `createConfig({ requestTimeoutMs: 1500 })` preserves that configured timeout through the existing request-policy Seam.
2. `describeRequest(path, { timeoutMs })` accepts a per-request override.
3. A per-request own `timeoutMs` property takes precedence over configured `requestTimeoutMs`.
4. `0` is a valid explicit timeout value and must remain `0`; it must not be treated as omitted or replaced by a default.
5. When neither configuration nor request options provide a timeout, the final descriptor must omit the `timeoutMs` property entirely. The existing descriptor remains exactly:
   ```js
   { path: "/users", retries: 2 }
   ```
6. A provided timeout is valid only when it is a non-negative safe integer.
7. Invalid configured or per-request timeout values throw exactly:
   ```text
   RangeError: timeoutMs must be a non-negative safe integer
   ```
8. Existing `path` and `retries` behavior remains unchanged.

### Public Interface change

```js
describeRequest(path, options?)
```

`options` supports an optional own `timeoutMs` property. Other option fields are outside this requirement and have no guaranteed behavior.

### Ownership and constraints

- Extend the existing configuration → request-policy → client flow; do not introduce a second configuration object.
- Timeout precedence, omission, and validation belong in the existing request-policy Module rather than the app/client composition code.
- Do not add a default timeout, compatibility fallback, silent coercion, dependency, feature flag, environment-variable lookup, or new public helper.
- Modify only the three inseparable production Modules and the existing integration test file.

## Required integration evidence

The integration test must prove:

1. Existing omission behavior is byte-for-byte structurally unchanged.
2. Configured timeout propagation.
3. Per-request override precedence.
4. Explicit zero preservation.
5. Exact configured-timeout `RangeError`.
6. Exact per-request-timeout `RangeError`.

## Complexity intent

This is Medium because it requires:

```text
3 production Modules
3 data-flow nodes
1 public Interface change
backward-compatible omission semantics
zero-value semantics
precedence behavior
2 reachable error paths with exact errors
1 integration test Seam
4 inseparable Writes
```

The expected result is one behavior-complete Task, not one Task per file or branch.
