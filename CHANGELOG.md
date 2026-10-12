# @interop/was-conformance-suite Changelog

## 0.31.0 - 2026-10-11

### Changed

- Follow was-client 0.97: `WasClient` takes the server's Spaces Repository URL
  (`<server-url>/spaces/`) as its `serverUrl`. The CLI's `<server-url>`
  positional and `TEST_SERVER_URL` remain the server's base URL; the suite
  derives the Spaces URL where it builds a client.
- Service description discovery probes the Spaces Repository URL rather than the
  server root. The spec starts discovery from any PWS URL, and a server's root
  need not be one.

## 0.30.1 - 2026-10-11

### Changed

- Update to latest was-client and vh log deps.

## 0.30.0 - 2026-10-05

### Changed

- `write-validation.collection-reserved-id-put` expects a create-by-id `PUT` at
  `/space/:s/export/meta` to be not found (404), not a 409 `reserved-id`. The
  URL lies beneath a reserved endpoint and names no Collection. The
  `reserved-id` assertion stays on the `POST` body case.

### Added

- `write-validation.reserved-segment-path-not-found`: a path beneath a reserved
  segment that no endpoint defines (`GET /space/:s/export/x`) is a 404.

## 0.29.1 - 2026-10-04

### Changed

- The Space Metadata comparisons accept an optional `replicas` member, checked
  for shape when present. This covers `spaces.create-and-read`,
  `space.create-post`, `space.read-authorized`, and `space.read-delegated`.
- The Collection Metadata comparisons accept an optional `created` member,
  checked as a write stamp when present. This covers
  `collections.create-and-describe`, `collection.create-post`, and
  `collection.read-metadata`.
- New exported helpers `withoutReplicas` and `withoutCreatingStamp`.

### Removed

- `reserved-methods.collection-query-get`. A server that replicates Spaces
  serves `GET /space/:s/:c/query` as the read-only form of the `changes` feed,
  so the method is no longer one every server refuses.

## 0.29.0 - 2026-10-04

### Added

- `changes-query-api` cases for the widened `changes` feed:
  `changes.kind-on-every-document`, `changes.deleted-member`,
  `changes.document-stamp-generation-etag`,
  `changes.non-json-resource-and-tombstone`,
  `changes.collection-metadata-document`, `changes.mixed-kind-paging`, and
  `changes.log-document` (skipped unless the server advertises
  `governed-history-logs`).

### Changed

- Change documents carry `deleted` in place of `_deleted`, and every case that
  reads the feed looks up Resources by `kind === 'resource'`.
- `changes.live-docs-tombstone-checkpoint` also checks `contentType` on the live
  document and the tombstone.
- `changes.concurrent-writes-not-skipped` pages from the checkpoint past the
  Collection's own `collection-metadata` document.
- Resource writes accept `201` on a create, `200` on an update or a metadata
  write, or `204`. A `2xx` body must hold only the server-managed members:
  `contentType`, `size`, and the write stamp, `createdAt` and `createdBy` only
  on a `201`, and `meta` only on a metadata write. This covers
  `resource.put-get`, `resource.put-upsert`,
  `resource.putmeta-ignores-server-managed`,
  `conditional.current-if-match-succeeds`,
  `conditional.if-none-match-create-succeeds`,
  `encryption.accepts-edv-document`, and `encryption.envelope-meta-etag`.

## 0.28.0 - 2026-10-03

### Added

- `write-stamp-api` suite: every versioned record (Space, Collection, and
  Resource Metadata objects, change documents) carries the write stamp
  (`updatedAt`, `updatedAtCounter`, `originId`); a metadata write adds the
  nested `meta` stamp; create echoes carry the stamp the following read returns;
  each `ETag` is one opaque strong validator that changes on every write,
  identical bodies and metadata-only writes included; the service description's
  `originId` matches the records (optional).
- `writer-attribution.meta-put-member-ignored`: a top-level `writerId` member on
  Update Resource Metadata is accepted and leaves the content write's label
  untouched.
- `withoutWriteStamp` and `assertWriteStamp` helpers (exported).

### Changed

- The seven exact-shape cases on Space and Collection Metadata objects and their
  create echoes admit the stamp members: `spaces.create-and-read`,
  `space.create-post`, `space.read-authorized`, `space.read-delegated`,
  `collections.create-and-describe`, `collection.create-post`,
  `collection.read-metadata`. `collection.create-post` also expects the echo to
  carry `createdAt` and `linkset`, the same object the following read returns.
- `encryption.replicates-metadata-changes` reads the nested `meta` stamp off the
  change document in place of `metaVersion`.
- Remaining `version` / `metaVersion` wording in case names and comments uses
  the stamp vocabulary.

### Removed

- `writer-attribution.meta-put-member-declares-and-clears`,
  `writer-attribution.invalid-meta-member-empty-400`, and
  `writer-attribution.invalid-meta-member-type-400`: the declare-or-clear rule
  for a `writerId` member on Update Resource Metadata was withdrawn.

## 0.27.0 - 2026-10-01

### Added

- `changes.concurrent-writes-not-skipped`: two Resources written concurrently to
  one Collection both surface when the feed is paged with `limit: 1`, and a
  document's own `checkpoint` resumes right after it.
- `changes.rewrite-after-checkpoint-surfaces`: a checkpoint issued before a
  rewrite, echoed back after it, surfaces the rewrite with its new body.
- `changes.retired-object-checkpoint-400`: an `{ id, updatedAt }` object
  checkpoint is refused with `invalid-request-body` (400).
- `changes.foreign-collection-checkpoint-400`: a checkpoint issued for another
  Collection is refused with `invalid-request-body` (400).

### Changed

- The `changes` checkpoint is an opaque string.
  `changes.live-docs-tombstone-checkpoint` asserts that every document carries a
  string `checkpoint` and that the page's `checkpoint` equals the last
  document's. `changes.malformed-checkpoint-400` sends a string the server did
  not issue.

## 0.26.0 - 2026-10-01

### Added

- `spaces.list-items-carry-type`: every List Spaces item carries a `type` array
  equal to its Space Metadata object's `type`, auxiliary Spaces included.

### Changed

- `spaces.list-includes-created` expects the listed item to carry
  `type: ['Space']`.

## 0.25.2 - 2026-09-30

### Fixed

- `governed-log.append-fast-forward-only` expects a `PUT` that re-sends the
  stored log byte for byte to be a no-op answered 204 with the current `ETag`,
  instead of a 400 `invalid-request-body`. Adding more than one line is
  still 400.

## 0.25.1 - 2026-09-30

### Fixed

- Fix lockfile.

## 0.25.0 - 2026-09-29

### Changed

- With an onboarding token configured, `space.create-put`,
  `conditional.space-if-none-match-create-then-412`, and
  `conditional.space-if-match-cas` create their Space by an unsigned `PUT` of
  its Space Metadata object carrying `Authorization: Bearer <token>`, since a
  server that gates provisioning gates Create Space by Id too.
  `space.create-put-controller-mismatch-400` skips under a token, as its
  `POST /spaces/` counterpart does. The context gains a `createSpaceByPut`
  helper for this.

## 0.24.0 - 2026-09-28

### Added

- `writer-attribution-api` suite: conformance checks for the `writerId`
  writer-attribution surface -- declare-or-clear on a content write (`PUT` /
  `POST`) and on `DELETE`, propagation to the Resource Metadata object, the
  Collection listing item summary, and the changes feed (including tombstones),
  the top-level `writerId` member of Update Resource Metadata, and rejection of
  an empty or non-string value with `invalid-request-body`. Gated behind the
  `metadata` service-description feature, matching how the other Resource
  Metadata checks are gated.

## 0.23.0 - 2026-09-27

### Changed

- `spaces.create-and-read`, `space.create-post`, `space.read-authorized` and
  `space.read-delegated` check the Space Metadata object's `backends` member. On
  a server that advertises the `backends` feature, it must equal the
  `GET /space/{space_id}/backends` listing. On one that does not, it must be
  absent.
- `space.create-post` expects `linkset` in the create echo, as Read Space
  already did.

## 0.22.1 - 2026-09-25

### Changed

- `spaces.configure-update` reads the renamed space from the
  `{ description, etag }` answer that `Space.configure` returns since
  `@interop/was-client` 0.68.0. Dependencies bumped to the current `@interop/*`
  releases.

## 0.22.0 - 2026-09-18

### Changed

- `space.create-post-conflict-preserves-original` now signs the conflicting
  `POST /spaces/` as Bob consenting for himself (`controller: bob.did`), instead
  of Alice proposing a different controller. Existence checking now runs after
  body-controller consent verification, so a non-consenting POST at an existing
  id gets `controller-mismatch` (400) rather than `id-conflict` (409); this case
  must consent to exercise the id-conflict path at all.

## 0.21.0 - 2026-09-16

### Changed

- `specRefs` cite the specifications by their persistent identifiers. Core
  anchors read `https://w3id.org/pws#`, matching the error `type` URIs the tests
  assert and the namespace the reference server emits.
- Anchors whose passages moved out of core cite the document that now carries
  them: `https://w3id.org/pws/authz-profile#` for delegation, the Digest header,
  the root capability, `PublicCanRead`, and capability invocation (which
  replaces the retired `#authorization-actions-and-the-root-capability`), and
  `https://w3id.org/pws/encrypted-collections#` for chunked Resources, the chunk
  operations, and the chunk address.
- The `PublicCanRead` policy cases cite the core Policy Type Registry beside the
  profile's definition of the type.
- Conditional-write checks no longer gate on a `conditional-writes` Backend
  token, and the check asserting a descriptor carries one is removed.
  Conditional writes are a baseline requirement of every backend, so the 412
  semantics now run unconditionally.
- The `changes-query` gate reads the service description's WAS version entry
  instead of a Backend descriptor. New `harness/serviceDescription.ts` fetches
  the document by following the `Link: rel="service"` header and reports the
  tokens a server advertises.
- The chunk, blinded-index, and governing-history-log suites gate on the
  Encrypted Collections entry in the service description
  (`https://w3id.org/pws/encrypted-collections`) instead of a Backend token. The
  chunk suite gates on the entry being listed at all, since that is itself the
  claim the endpoints are served; the other two gate on the
  `blinded-index-query` and `governed-history-logs` tokens of its `features`
  array.
- Backend descriptor checks no longer expect a `features` array; the spec
  dropped the property.
- Every asserted problem type now carries the base identifier
  `https://w3id.org/pws`, replacing `https://wallet.storage/spec`. The fragments
  are unchanged, so a server still answering under the old base fails these
  checks.

## 0.20.0 - 2026-09-16

### Changed

- Backend descriptor checks no longer expect a `storageMode` member; the spec
  dropped the property.

## 0.19.0 - 2026-09-14

### Added

- New `service-description-api` suite: discovers the service description via the
  `Link: rel="service"` header rather than a fixed path, checks the header and
  `Access-Control-Expose-Headers` on a success, an error, a 308 redirect, and a
  CORS preflight, validates the document against the data model and the
  `https://w3id.org/pws` version 0.5 entry, and checks the optional
  caching/conditional-read behavior.

## 0.18.0 - 2026-09-14

### Changed

- `container-rule-api`: `PUT /space/:s/:c/meta` under a grant targeting the
  Collection URL is now asserted to succeed (204, the object rewritten) instead
  of being refused. A Collection-scoped grant declares the Collection's own
  indexes and `encryption`; Delete Collection stays root-only.

## 0.17.0 - 2026-09-13

### Added

- `container-rule-api`: the four container operations that target attenuation
  cannot tell apart. `PUT /space/:s/meta` on an existing Space and
  `DELETE /space/:s/:c/` take a direct root invocation only; a delegated
  capability is refused 404 whatever its `allowedAction`. `DELETE /space/:s/`
  also accepts a grant targeting exactly the trailing-slash Space URL with
  `allowedAction` exactly `['DELETE']`, and refuses a two-verb grant.
  `PUT /space/:s/:c/meta` also accepts a grant targeting exactly the
  trailing-slash Space URL, and refuses one targeting the Collection URL.
  `POST /space/:s/` stays delegable. Each refusal re-reads the target to show
  nothing changed behind the 404.

## 0.16.0 - 2026-09-12

### Changed

- Targets the WAS v0.5 route table; a v0.4 server no longer passes. Space and
  Collection Metadata objects are read and written at `/space/:s/meta` and
  `/space/:s/:c/meta`, `PUT` there creates the container, containers are
  addressed with a trailing slash, and `GET /space/:s/` lists Collections. The
  Space root capability id is minted from the trailing-slash Space URL.
- `@interop/was-client` peer and dev dependency raised to 0.61.0 (the v0.5
  client).
- `collection.meta-etag-independent-of-description` is replaced by
  `collection.meta-configuration-and-annotation-share-etag`: a configuration
  write and a `custom` write advance the same `ETag`.
- `collection.meta-put-missing-collection-404` is replaced by
  `collection.meta-put-creates-missing-collection` (201).
- `collection.meta-reserved-resource-id-409` is replaced by
  `collection.meta-delete-405-not-reserved-id`: `DELETE` at the Collection
  `meta` URL is 405 with `Allow`.
- `collection.read-description` is renamed `collection.read-metadata`.
- `write-validation.collection-reserved-id-put` now creates at
  `PUT /space/:s/export/meta`.
- `encryption.clear-descriptor-immutable` now requires 409
  `encryption-immutable`, since a Metadata `PUT` omitting `encryption` clears
  it.
- Test titles say "Space Metadata object" / "Collection Metadata object" instead
  of "description", and `specRefs` point at the v0.5 anchors.

### Added

- `reserved-methods-api`: a method a server does not implement at a reserved
  endpoint is 405 with an `Allow` header omitting it, an `about:blank` problem
  and the title `Method Not Allowed`, at all three levels. Endpoints of an
  OPTIONAL feature group also accept 501. Also asserts the same answer for an
  absent Space id; `HEAD` following `GET` and `OPTIONS` reaching CORS preflight
  are optional.
- `PUT` at a Space or Collection container URL is 405 (required).
- The slash-less form of a Space or Collection URL 308-redirects to the
  canonical form, and the canonical form does not redirect (optional).
- `/space/:s/collections/` may 308 to the Space URL (optional, skips otherwise).
- `meta` is a reserved Collection id: `POST /space/:s/` with `id: "meta"` is 409
  `reserved-id`.
- Container `url` members and the Create Collection `Location` carry the
  trailing slash.
- A Collection Metadata update omitting `backend` keeps the stored selection
  (optional; skips when no backend can be registered).
- `If-None-Match: *` on a Collection Metadata `PUT` refuses a Collection that
  was created by `POST`, and `GET /space/:s/:c/meta` answers 304 to a covering
  `If-None-Match` (optional).

### Removed

- `write-validation.resource-reserved-id-put` and
  `ordering.resource-post-conflict-404`. The spec no longer lists `reserved-id`
  or an existing-id `id-conflict` for Resource creation: Create Resource
  generates the id, and a reserved segment in the Resource position is a
  reserved endpoint.

### Fixed

- Suite teardowns deleted the slash-less Space URL, which a v0.5 server
  redirects, so test Spaces were left behind.

## 0.15.0 - 2026-09-10

### Changed

- Bumped `@interop/ed25519-verification-key` to 8.2.0 and switched the test
  actors' `did:key` signers to its new `didKeySigner()` instead of mutating
  `keyPair.id`/`controller` before calling `signer()`.

## 0.14.0 - 2026-09-10

### Added

- `denial-reasons-api`: a refused capability invocation is still a 404, and a
  server may name two causes by `type` alone to the holder of the affected
  chain: `capability-expired` and `capability-revoked` (optional; the revocation
  cases skip when the server has no revocation endpoint). A copy of the grant
  invoked without its controller's key, and a refusal for any other reason, stay
  the merged `not-found` (the latter required).

## 0.13.0 - 2026-09-08

### Added

- `conditional-requests-api`, a "Descriptions" group: a Collection PUT with
  `If-None-Match: *` creates an absent Collection and 412s on a present one;
  Read Space carries a quoted `ETag` and a covering `If-None-Match` is 304
  (optional, the spec's SHOULD); a Space PUT with `If-None-Match: *` creates an
  absent Space and 412s on a present one; a stale `If-Match` on Update Space
  412s while the current one succeeds and an unconditional PUT still replaces.
  The write cases skip when the default backend does not advertise
  `conditional-writes`.

## 0.12.0 - 2026-09-07

### Added

- `governed-log-api`: an append must fast-forward the stored log. A body the
  stored log is not a prefix of is 412 `precondition-failed` even under a
  current `If-Match`; a body adding no line or several is 400
  `invalid-request-body`; the log is unchanged either way.

## 0.11.0 - 2026-09-07

### Added

- A `governed-log-api` suite for a Collection's governing history log, the
  `.../meta/log` sub-resource, gated on a backend advertising
  `governed-history-logs`: a guarded create (`If-None-Match: *`) governs the
  Collection and its served `encryption` member equals the log head's `state`
  plus `history: { method, resource }`; the log reads back verbatim as
  `text/jsonl` with its `ETag`; an `If-Match` append lands and bumps both the
  log and Description `ETag`s while a stale one is 412; a direct `encryption`
  write on a governed Collection is 409 `encryption-history-log-governed`; an
  append that drops an epoch is 400 and leaves the log unchanged; a
  line-contract break is 400 `invalid-request-body`; governing an
  already-described Collection is 409 `encryption-immutable`; the log is absent
  from the listing, exempt from the envelope rule, untouched by a `PUT /meta`,
  readable under a capability on the Collection URL, masked as 404 for another
  controller, and removed with the Collection.

### Fixed

- The optional backend-description cases in `client-spaces` pin the reference
  server's current `features` list, which now ends in `governed-history-logs`.

## 0.10.0 - 2026-09-07

### Added

- `conditional-requests-api` gains optional-tier conditional-read cases (spec
  "Caching"): a GET or HEAD with an `If-None-Match` matching the current `ETag`
  is 304 with the `ETag` and no body while a stale validator is 200, a `W/`
  validator, a list, and `*` all match (weak comparison), another controller's
  conditional GET is the 404 mask rather than a 304, and a POST response carries
  `Cache-Control: no-store`.

## 0.9.0 - 2026-09-05

### Added

- `encryption-descriptor-api` covers the descriptor's `hmac` blinding-key
  member: it persists and echoes verbatim, a malformed member (missing `id` or
  `type`, empty `recipients`, bad entry shape) is 400 `invalid-request-body`,
  changing its `id` or removing it on update is 409 `encryption-immutable`, and
  changing its `recipients` or introducing it on a descriptor that lacks it is
  accepted.

## 0.8.0 - 2026-09-05

### Added

- A `plaintext-declaration-api` suite for the Collection `plaintext` member and
  its `indexes` declaration: `plaintext.indexes` persists and echoes on POST and
  PUT create, `plaintext` and `encryption` both present is 400 on create and on
  update in either direction (an empty `plaintext` still excludes), malformed
  `plaintext` is 400, `plaintext` is added, changed, and emptied with `{}` on an
  existing Collection, and a `unique` index conflict is 409 at write time and
  when promoting an attribute to unique over colliding Resources. The suite is
  optional until the spec text for `plaintext` lands.

## 0.7.0 - 2026-08-29

### Changed

- The suite signs its delegation proofs with `eddsa-jcs-2022` instead of
  `Ed25519Signature2020`. That is what current WAS clients emit, so the required
  tests now exercise the cryptosuite a server actually meets. A server that
  verifies only `Ed25519Signature2020` fails the delegated tests until it
  accepts both; `was-teaching-server` does so from 0.23.0.

### Added

- A `delegation-cryptosuites` suite: a server accepts a delegation proof signed
  with `eddsa-jcs-2022`, one signed with `Ed25519Signature2020`, and a chain
  whose links mix the two -- rather than the run silently tracking whichever
  suite it happens to send. Only the `eddsa-jcs-2022` test is required, matching
  what the rest of the suite signs with. The two tests involving
  `Ed25519Signature2020` are optional: a server may reasonably have moved past
  it, and the spec's authorization profile names no cryptosuite either way.
- `Actor.signer` on the test identities, so a suite can build a client of its
  own -- one signing with a different cryptosuite, for instance -- without
  reaching into `rootClient`.

### Fixed

- The README's suite-id table lists all 20 suites; it had been missing seven
  added since it was written.

## 0.6.1 - 2026-08-20

### Added

- `repository.create-controller-unsupported-did-method-400` and
  `space.update-controller-unsupported-did-method-400` in the `spaces-api`
  suite: a `controller` that is a valid DID of a method not in the spec's Space
  Controller DID Method Registry (`did:web`) is refused with 400
  `invalid-request-body`, on create and on update by the stored controller, and
  the update leaves the stored controller unchanged.

## 0.6.0 - 2026-08-12

### Added

- Codec-path tests in the `blinded-index-api` suite, grouped as `codec path` and
  gated on the same `blinded-index-query` feature detection: an encrypted
  Collection is provisioned through `@interop/was-client`
  (`encryption: { scheme: 'edv' }`, a first key epoch with `blindedIndex: true`,
  and a declared index), documents are written with `add()`, and the server
  matches the client-computed tokens -- `find({ equals })` returns them
  decrypted, `find({ has })` and `find({ count: true })` match on presence and
  tally, and a write colliding on a `unique` declared attribute is refused with
  409 `id-conflict` (surfaced as the client's `ConflictError`). The existing
  tests seed hand-built envelopes, which cannot show that a real client's tokens
  are the tokens this server matches.

### Changed

- `@interop/was-client` peer range raised to `>=0.35.0 <1.0.0` (the version that
  ships the `/edv` blinded-index API the new tests import).
- Added `@interop/x25519-key-agreement-key` as a dependency (the key-agreement
  key the codec-path collection's epoch wraps to).

## 0.5.0 - 2026-08-12

### Added

- Collection Metadata (`GET`/`PUT /space/{spaceId}/{collectionId}/meta`) tests
  in the `collection-api` suite, skipped as a group when a server answers 501
  `unsupported-operation` (the endpoints are OPTIONAL): a signed read is 200
  `application/json` while an anonymous one is 404 `application/problem+json`, a
  write sets `custom` and returns an ETag that a read round-trips, a write with
  no `custom` clears it (full replacement), server-managed top-level members in
  the body are ignored (read-modify-write is safe), a write to a nonexistent
  Collection is 404, a non-object `custom` is 400 `invalid-request-body`, a
  stale `If-Match` is 412 `precondition-failed` while the current one succeeds,
  the metadata ETag is independent of the Collection Description ETag, and
  `meta` is a reserved Resource id (409 `reserved-id`).

## 0.4.3 - 2026-08-09

### Added

- Encryption-descriptor `version` tests in the `encryption-descriptor-api`
  suite: an integer `version` round-trips, a non-integer version is 400
  `invalid-request-body`, an explicit `version: 1` on a formerly versionless
  descriptor is accepted (absent means `1`), removing a set version is 409
  `encryption-immutable` (or a no-op that preserves it), raising the version is
  never an immutability conflict, and (optional tier) an unrecognized version of
  a recognized scheme is rejected with `unsupported-encryption-scheme` or stored
  opaquely verbatim.

## 0.4.2 - 2026-08-07

### Added

- Delegated Create Space failure-shape tests in the `spaces-api` suite: a chain
  rooted in a different DID than the body's `controller`, an expired delegation
  (proof backdated via ezcap's `now` override), and a delegation whose proof
  fails verification each yield 400 `controller-mismatch` and leave the Space
  uncreated. An optional-tier test asserts the three failure causes carry
  pairwise-distinct non-empty `detail` strings (top-level or in the `errors`
  array), asserting nothing about wording.

## 0.4.1 - 2026-08-01

### Changed

- Update to latest `@interop/was-client@0.23.0`.

## 0.4.0 - 2026-08-01

### Changed

- **BREAKING: the encryption suite's wire-stable ids renamed to "descriptor"**,
  following the spec's rename of the Collection `encryption` member from
  "marker" to "encryption descriptor". The suite id (CLI `--suite` selector /
  report key) is now `encryption-descriptor-api` (was `encryption-marker-api`),
  and the test ids are `encryption.persist-echo-descriptor`,
  `encryption.delegated-discovers-descriptor`,
  `encryption.malformed-descriptor-400`, and
  `encryption.clear-descriptor-immutable`; `encryption.change-scheme-immutable`
  and `encryption.unrecognized-scheme-400` are unchanged. Report consumers and
  `--suite`/`--grep` invocations keyed on the old strings must update. The
  `encryptionMarkerApi` export is now `encryptionDescriptorApi` (file
  `src/suites/encryption-descriptor-api.ts`), and report-visible test names and
  prose (including the chunks-api test naming the descriptor) follow suit.
- The two `specRefs` pointing at the dangling anchor
  `https://wallet.storage/spec#the-encryption-marker` (which never existed in
  the spec) now point at the real
  `https://wallet.storage/spec#collection-data-model` anchor.

## 0.3.1 - 2026-07-23

### Changed

- `spaces-api` suite: the List All Collections test now accepts the
  spec-optional `public` member on listing items. When a server surfaces it, the
  test enforces the spec's consistency rules (present on every item, and
  explicitly `false` for a Collection with no policy attached) instead of
  failing on the extra field.

## 0.3.0 - 2026-07-22

### Added

- `changes-query-api` suite: a query body with no `profile` member is rejected
  with 400 `invalid-request-body` (the Query Profile Registry marks `profile`
  REQUIRED), distinct from the 501 answered for an unrecognized profile.

- New `chunks-api` suite: Chunked Resources conformance (skipped unless the
  default backend advertises `chunked-streams`; required-tier once it does).
  Covers the octet-stream round-trip (PUT/GET/HEAD/DELETE plus the chunk
  listing), rejection of non-canonical `{index}` values with 400 `invalid-id`,
  opaque chunk bodies accepted verbatim even on an encryption-marked Collection,
  404 for a chunk PUT to a missing parent Resource, the deliberately
  non-idempotent 404 on deleting an absent chunk, cascade deletion of chunks
  with their parent, chunk-write invisibility to the `changes` feed, capability
  URL-binding via a sibling-chunk probe, and cross-user 404 masking of chunk
  URLs.
- New `conditional-requests-api` suite: conditional writes and caching (skipped
  unless the default backend advertises `conditional-writes`, apart from the
  token-advertisement probe itself). A stale `If-Match` PUT and an
  `If-None-Match: *` PUT against an existing Resource are rejected with 412
  `precondition-failed` without performing the write; the matching happy-path
  anchors succeed; and an under-authorized conditional PUT yields the
  privacy-merged `not-found` (404) mask, never 412. Optional/SHOULD tests assert
  `ETag` on Resource GET and HEAD, changing when content changes.
- New `blinded-index-api` suite: the `blinded-index` query profile (skipped
  unless the default backend advertises `blinded-index-query`). Covers `equals`
  and `has` matching with ascending-id ordering, the `count:true` shape,
  `hasMore`/`cursor` pairing, 400 `invalid-request-body` for a query with
  neither/both of `equals`/`has` or a missing `index`, 400 `invalid-cursor` for
  a garbage continuation token, 409 `id-conflict` for a write claiming an
  already-held `unique` blinded triple, and the 404 mask when an
  under-authorized caller probes a held triple.
- `spaces-api` suite: remaining Create/Update Space MUST branches. A body `id`
  that is not URL-safe is rejected with 400 `invalid-id`; a `controller` that is
  not a DID is rejected with 400 `invalid-request-body`; a delegated Create
  Space (invoked by a delegate whose capability chain is rooted in the body
  controller) succeeds with 201; a conflicting `POST` leaves the existing Space
  untouched; a body-supplied `createdBy` is ignored; a PUT-create not authorized
  by the body controller is rejected with 400 `controller-mismatch` and creates
  nothing; error bodies carry both a non-empty `type` and `title`; and the
  reserved `policy` segment is served as the policy endpoint, not as a
  Collection.
- `collection-api` suite: creating a Collection whose `backend.id` names an
  unregistered backend is rejected with 409 `unsupported-backend`; and a single
  delegated list capability authorizes an entire paginated traversal (following
  `next` across pages without re-delegation).
- `resource-api` suite: multipart uploads with zero or two file parts are
  rejected with 400 `invalid-request-body`; a GET with an unsatisfiable `Accept`
  still returns the stored representation (never 406); and a `PUT .../meta`
  carrying top-level server-managed properties alongside `custom` leaves
  `contentType`/`size` unchanged.
- `changes-query-api` suite: a `changes` query with a malformed `checkpoint` is
  rejected with 400 `invalid-request-body`.
- `encryption-marker-api` suite: a structurally valid envelope written under the
  wrong `Content-Type` into an encryption-marked Collection is rejected with 422
  `encryption-scheme-mismatch`.
- `specRefs` populated on every test in the registry, so spec-vs-suite coverage
  audits are mechanical.
- New `invocation-target-api` suite: capability `invocationTarget` binding
  negatives. Delegates a Resource-scoped capability and invokes it -- via the
  low-level `signCapabilityInvocation` primitive, since a well-behaved client
  refuses to build such a request -- against URLs the capability does not name:
  a sibling Resource (read and delete, asserting the delete is not performed),
  the parent Collection listing, and a Resource in another Space under the same
  controller. Each invocation must be rejected as either a verification failure
  (400 `invalid-authorization-header`) or the privacy-merged `not-found` (404)
  mask, without disclosing the target's content.
- `encryption-marker-api` suite: marker-immutability negatives. Changing the
  `scheme` of an existing `encryption` marker must be rejected -- with 409
  `encryption-immutable`, or with 400 `unsupported-encryption-scheme` on a
  server whose fail-closed registry gate reports the (necessarily unrecognized)
  probe scheme first -- and the stored marker must survive intact. An update
  sent without `encryption` must not clear an existing marker: it is either
  rejected with 409 `encryption-immutable` or accepted with the marker
  preserved. The pre-existing unrecognized-scheme test now probes a fresh
  Collection, so the fail-closed 400 is asserted unambiguously on a first
  declaration rather than overlapping the set-once check.
- `spaces-api` suite: direct Create/Update Space controller negatives. A
  `POST /spaces/` without a `controller` in the body is rejected with 400
  `invalid-request-body` (asserted on both the onboarding-token and signed-zcap
  provisioning paths); a `POST /spaces/` signed by a key that is not the body's
  `controller` is rejected with 400 `controller-mismatch` and the Space is not
  created (skipped when an onboarding token is configured, since the token then
  vouches for provisioning); and a PUT that swaps `controller` on an existing
  Space, signed by the would-be new controller, is verified against the _stored_
  controller -- it yields the privacy-merged `not-found` (404) mask and does not
  transfer the Space.
- New `write-validation-api` suite: write-validation negatives. Creating a
  Collection with a reserved path-segment id -- via either create wire shape
  (POST with a body `id`, or PUT with the id in the path) -- and creating a
  Resource with a reserved id are rejected with 409 `reserved-id`; a Resource
  write carrying no `Content-Type` header is rejected with 400
  `missing-content-type`.
- New `digest-api` suite: request-body integrity (Digest) negatives. Uses the
  low-level `signCapabilityInvocation` primitive to send requests a well-behaved
  client never produces: a signed body request whose signature does not cover
  the `digest` header (MUST reject with 400 `invalid-authorization-header`), and
  -- as an optional/SHOULD test -- a request whose body was swapped after
  signing, which must be rejected and not performed.
- New `authz-ordering-api` suite: authorization-ordering / no-leak negatives.
  Every test invokes as an under-authorized (cross-user) caller and asserts the
  privacy-merged `not-found` (404) mask instead of the later-stage error a
  server would leak by checking in the wrong order: id-conflict detection (409,
  Collection and Resource create), encrypted-Collection envelope validation
  (422), List-Collection cursor and query-body validation (400/501), Space and
  Collection quota reads (403/501), and Resource DELETE (which must also not be
  performed).

## 0.2.0 - 2026-07-22

### Changed

- **BREAKING**: `@interop/was-client` is now a peerDependency
  (`>=0.18.0 <1.0.0`) instead of a regular dependency, so a host repo that also
  depends on `was-client` gets a single shared copy instead of a nested
  duplicate pinned to this suite's range. Setups with peer auto-install disabled
  must add `@interop/was-client` themselves.

## 0.1.2 - 2026-07-21

### Fixed

- Add `equality-query` to the expected default-backend `features` list in the
  optional backend read/list tests, matching what conforming servers now
  advertise.

## 0.1.0-0.1.1 - 2026-07-19

### Added

- Conformance test suite for Wallet Attached Storage (WAS) servers: black-box
  HTTP tests covering spaces, collections, resources, access-control policies,
  collection change queries, encryption markers, ZCap delegation, space
  export/import, and BYOS backend registration. Tests that reflect
  reference-server behavior rather than clear spec mandates are tagged optional
  and reported as warnings by default.
- Programmatic API: `runConformance({ serverUrl, onboardingToken, onEvent })`
  runs the suite (or a subset) against a server and returns a structured
  `RunReport`; the `suites` registry, runner, and result types are exported for
  embedding in other test harnesses. Isomorphic -- runs in Node and, via a
  bundler, in the browser.
- `was-conformance` command-line runner: point it at a server URL (or
  `TEST_SERVER_URL`), with options for an onboarding token, suite and test-name
  filters, optional-test handling (`--include-optional` / `--skip-optional`), a
  per-test timeout, and `--fail-fast`. Ships `pretty` (default, colorized, live)
  and `json` (CI) reporters, a preflight connectivity check, and CI exit codes
  (0 pass, 1 conformance failures, 2 usage or unreachable server).
- Browser web app (`web/`, deployed to GitHub Pages): paste a server URL and
  optional onboarding token, pick suites and optional-test handling, and watch
  the suite run live -- per-suite progress, expandable failure details with
  expected/actual diffs and spec links, a final conformance verdict, and
  copy/download of the same JSON report the CLI emits. Runs entirely client-side
  (the token never leaves the browser), with a preflight check that
  distinguishes network/CORS unreachability from test failures.
