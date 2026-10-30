# PWS Conformance Suite _(@interop/pws-conformance-suite)_

[![Node.js CI](https://github.com/interop-alliance/pws-conformance-suite/workflows/CI/badge.svg)](https://github.com/interop-alliance/pws-conformance-suite/actions?query=workflow%3A%22CI%22)
[![NPM Version](https://img.shields.io/npm/v/@interop/pws-conformance-suite.svg)](https://npm.im/@interop/pws-conformance-suite)

> Conformance test suite for
> [Portable Web Spaces (PWS)](https://w3c-ccg.github.io/portable-web-spaces-spec/)
> servers, runnable as a CLI, in the browser, or as a library.

## Table of Contents

- [Background](#background)
- [Security](#security)
- [Install](#install)
- [Usage](#usage)
  - [CLI](#cli)
  - [Web app](#web-app)
  - [Programmatic API](#programmatic-api)
  - [Onboarding token](#onboarding-token)
  - [Optional vs required tests](#optional-vs-required-tests)
  - [Adding a test](#adding-a-test)
- [Contribute](#contribute)
- [License](#license)

## Background

This suite black-box tests any running Portable Web Spaces server implementation
over HTTP: spaces, collections, resources, access-control policies, change
queries, encryption descriptors, ZCap delegation, and space export/import. It
never inspects server internals -- point it at a server URL (plus an optional
onboarding token, if the server gates provisioning) and it reports per-test
pass/fail results against the
[PWS spec](https://w3c-ccg.github.io/portable-web-spaces-spec/).

### The server URL must be byte-identical everywhere

ZCap authorization embeds the invocation target URL (including host and port) in
signed capabilities, and servers verify it as an exact string match. The URL you
point this suite at must therefore be **byte-identical** to the URL the server
believes it is serving on (e.g. its `SERVER_URL` setting). In particular,
`http://localhost:3002` and `http://127.0.0.1:3002` are _not_ interchangeable --
a mismatch makes the delegated-access tests fail with 404s even though the
server is otherwise reachable.

## Security

The suite uses hardcoded, publicly known did:key test seeds (deterministic test
identities for its "alice"/"bob" actors). Never authorize these identities on a
production server. Onboarding tokens are only sent as `Authorization: Bearer`
headers to the server under test.

## Install

- Node.js 24+ is recommended.

### PNPM

To install via PNPM:

```
pnpm install @interop/pws-conformance-suite
```

### Development

To install locally (for development):

```
git clone https://github.com/interop-alliance/pws-conformance-suite.git
cd pws-conformance-suite
pnpm install
```

## Usage

The suite runs the same test registry three ways: from the command line, from a
hosted web app, or as a library. In every case you provide a PWS server URL and,
if the server gates provisioning, an [onboarding token](#onboarding-token).

Remember the
[byte-identical URL constraint](#the-server-url-must-be-byte-identical-everywhere):
the server URL you pass must exactly match the URL the server is configured to
serve on.

### CLI

The package ships a single `pws-conformance` bin, so you can run it directly
with `npx` (no install step needed):

```
npx @interop/pws-conformance-suite http://localhost:3002
```

Or, once installed:

```
pws-conformance http://localhost:3002
```

Options:

```
Usage: pws-conformance <server-url> [options]

Runs the PWS conformance suite against a running server.
<server-url> falls back to the TEST_SERVER_URL environment variable.

Options:
  -t, --token <token>       onboarding token (or TEST_ONBOARDING_TOKEN)
  -s, --suite <id>          run only the named suite(s), repeatable
  -g, --grep <pattern>      filter tests by name
      --include-optional    treat optional tests as required (default: run
                            them but report as warnings)
      --skip-optional       do not run optional tests at all
  -r, --reporter <name>     pretty (default) | json
      --timeout <ms>        per-test timeout
      --fail-fast           stop on first failure
  -h, --help                show this help and exit
  -V, --version             print the version and exit
```

The available suite ids (for `--suite`) are:

| id                          | tests                                                   |
| --------------------------- | ------------------------------------------------------- |
| `authz-ordering-api`        | Authorization ordering (no-leak negatives)              |
| `blinded-index-api`         | Blinded-index query profile                             |
| `changes-query-api`         | Collection changes query profile                        |
| `chunks-api`                | Chunked Resources API                                   |
| `client-backends`           | WasClient -- BYOS backend registration                  |
| `client-delegation`         | WasClient -- Delegation                                 |
| `client-export-import`      | WasClient -- Export / Import                            |
| `client-resources`          | WasClient -- Resources                                  |
| `client-spaces`             | WasClient -- Spaces & Collections                       |
| `collection-api`            | Collections API                                         |
| `conditional-requests-api`  | Conditional requests & caching                          |
| `container-rule-api`        | The container rule                                      |
| `delegation-cryptosuites`   | Delegation-proof cryptosuites                           |
| `denial-reasons-api`        | Typed denial reasons (capability-expired / -revoked)    |
| `digest-api`                | Request body integrity (Digest) negatives               |
| `encryption-descriptor-api` | Encryption descriptor API                               |
| `governed-log-api`          | Governing history log API                               |
| `invocation-target-api`     | Capability invocationTarget binding                     |
| `plaintext-declaration-api` | Plaintext declaration API                               |
| `policy-api`                | Access-control policy API                               |
| `reserved-methods-api`      | Methods at reserved endpoints (405)                     |
| `resource-api`              | Resource API                                            |
| `server`                    | Server                                                  |
| `spaces-api`                | Spaces                                                  |
| `write-stamp-api`           | Write stamps and validators                             |
| `write-validation-api`      | Write-validation negatives (reserved ids, Content-Type) |
| `writer-attribution-api`    | Writer attribution (`writerId`)                         |

#### Environment-variable fallbacks

Two settings can be supplied via the environment instead of on the command line:

- `TEST_SERVER_URL` -- used when the `<server-url>` positional is omitted.
- `TEST_ONBOARDING_TOKEN` -- used when `--token` is omitted.

```
TEST_SERVER_URL=http://localhost:3002 TEST_ONBOARDING_TOKEN=secret pws-conformance
```

#### Exit codes

- `0` -- all required tests passed.
- `1` -- one or more conformance (required-test) failures.
- `2` -- usage error, or the server could not be reached.

Optional-test failures do not affect the exit code unless `--include-optional`
promotes them (see [below](#optional-vs-required-tests)).

#### JSON reporter for CI

For machine-readable output, use the JSON reporter:

```
pws-conformance http://localhost:3002 --reporter json
```

It writes a structured report to stdout while preserving the same exit-code
semantics, so a CI job can both assert on the exit code and archive the report.

### Web app

A hosted runner is available at
<https://interop-alliance.github.io/pws-conformance-suite/>. Paste in a server
URL and an optional onboarding token, and the suite runs **fully client-side in
your browser** -- the token is used only to talk to the server under test and
never leaves the browser.

Because the run happens in the browser, the server under test must allow
[CORS](https://developer.mozilla.org/docs/Web/HTTP/CORS) from the web app's
origin. If a run is diagnosed as "server unreachable from a browser (network or
CORS)", use the [CLI](#cli) instead, which is not subject to browser CORS
restrictions.

You can prefill the server URL field with the `?server=` query parameter, e.g.
`.../pws-conformance-suite/?server=http://localhost:3002`.

To run the web app locally during development:

```
pnpm web:dev
```

### Programmatic API

Import `runConformance` (and, if you want to select a subset, `suites`) and read
the returned `RunReport`:

```ts
import { runConformance, suites } from '@interop/pws-conformance-suite'

const report = await runConformance({
  serverUrl: 'http://localhost:3002',
  onboardingToken: 'secret', // omit or null if provisioning is open
  suites, // optional: defaults to the full registry
  onEvent: event => {
    if (event.type === 'test-end') {
      console.log(event.result.status, event.result.name)
    }
  }
})

console.log(`conformant: ${report.conformant}`)
console.log(report.counts) // { total, pass, fail, skip, optionalFail }
```

`report.conformant` is `true` when no required test failed. See
[`src/harness/types.ts`](src/harness/types.ts) for the full `RunReport`,
`RunEvent`, and `TestResult` shapes.

### Onboarding token

Some PWS servers gate space provisioning behind a shared-secret onboarding
token. When configured, the suite sends it as an `Authorization: Bearer` header
on provisioning requests. If a server does not gate provisioning, space creation
is open and no token is needed -- omit `--token` / `TEST_ONBOARDING_TOKEN` and
the `onboardingToken` option.

### Optional vs required tests

Some tests are tagged **optional**: they reflect reference-server-flavored
behavior that is not clearly mandated by the spec. By default optional tests
still run, but their failures are reported as warnings and do **not** affect the
exit code. Two flags change this:

- `--include-optional` promotes optional tests to required, so their failures
  count toward the exit code.
- `--skip-optional` does not run optional tests at all.

### Adding a test

Tests live in `src/suites/*.ts` as plain data. A suite is a `Suite` object with
an array of `TestCase` entries; each test has:

- a stable `id` slug (e.g. `spaces.create-post`), unique within its suite;
- a human-readable `name`;
- a `run(ctx, state)` function that receives the test context (server URL, test
  actors, and the provisioning/utility helpers) and throws on failure.

Register a new suite by adding it to the registry in
[`src/suites/index.ts`](src/suites/index.ts). Write assertions through the local
assert module ([`src/harness/assert.ts`](src/harness/assert.ts)) so they work
unchanged in both Node and the browser.

## Contribute

PRs accepted. See [CONTRIBUTING.md](CONTRIBUTING.md) for editor setup (Prettier,
ESLint, and EditorConfig) and how it maps to CI.

If editing the Readme, please conform to the
[standard-readme](https://github.com/RichardLitt/standard-readme) specification.

## License

[MIT License](LICENSE.md) © 2026 Interop Alliance. </content> </invoke>
