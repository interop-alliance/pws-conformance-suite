# Agent Guidelines

This repo is `@interop/pws-conformance-suite`, a black-box conformance test
suite for Portable Web Spaces (PWS, formerly Wallet Attached Storage / WAS)
servers, runnable as a CLI, a hosted web app, or a library.

## Roadmap & Task Conventions

Roadmap tracking lives in `_spec/ROADMAP.md` (a local, gitignored planning dir):
narrative context plus structured `### PWSCS-N` work items, following the item
structure shared with the isomorphic-lib-template, freewallet, and spec-repo
roadmaps. Never create a parallel task list elsewhere. The full item schema
lives in that file's header; the rules that apply when working an item:

- Item ids are permanent and never reused. The `nextAvailableId: <n>` line at
  the top of `_spec/ROADMAP.md` is the sole source of the next id: filing an
  item takes `n` and rewrites the line to `n + 1`, in the same edit. Never
  derive the next id by scanning the roadmap; the highest id usually lives in
  `_spec/historical/archived-roadmap.md`, not in the open roadmap. If the
  counter's id already appears in either file, the counter is stale: reset it to
  one past the highest id across both files, then take it.
- Statuses are edited in place; acceptance checkboxes are ticked as they are
  met. Every non-draft item needs acceptance criteria before it may be moved to
  `in-progress`.
- **Completing an item includes archiving it**: in the same pass that marks it
  `done`, move it verbatim (number, title, field block, prose, with its `done`
  date) from `_spec/ROADMAP.md` to `_spec/historical/archived-roadmap.md`,
  append-only at the bottom. A `done` item left in ROADMAP.md is an unfinished
  task. CHANGELOG.md remains the record of what landed; do not rewrite or
  summarize items on the way into the archive.
- Work discovered mid-implementation gets its own PWSCS-N item immediately,
  noting `discovered-from: PWSCS-N` in its prose, plus a `blocked-by` link if it
  blocks anything.
- A cross-cutting item -- one changing the harness contract (the case and suite
  shape, the runner interface, or the reporter output), the provisioning or
  teardown model, or how a suite decides to skip rather than fail -- is behind
  the **design gate**: it carries `design:` and `design-approved:` fields, and
  no implementation starts until the named document under `_spec/designs/`
  exists and is approved by core contributors. A change confined to one suite's
  assertions skips the gate. The convention and doc template are canonical in
  [isomorphic-lib-template's `designs/`](https://github.com/interop-alliance/isomorphic-lib-template/tree/main/designs);
  the suite-local specifics live in the roadmap file's header.

Two things this repo publishes are wire contracts, so an item changing either
carries a `touches:` field (schema in isomorphic-lib-template's AGENTS.md) and
the change needs sign-off before it is coded: the case and suite ids, which
downstream reports and CI configs name, and the JSON reporter's output shape.
Reference item ids in commit messages and PR descriptions where relevant.

## Ecosystem conventions

- Cross-repo lessons (invariants, gotchas, and process recipes that span repos)
  live in the ecosystem learnings file,
  [byoe-ecosystem/LEARNINGS.md](https://github.com/interop-alliance/byoe-ecosystem/blob/main/LEARNINGS.md)
  (usually checked out beside this repo as `../byoe-ecosystem`); read it at the
  start of any cross-repo task.
- Cross-repo decisions are recorded as `decisions/NNNN-slug.md` in the repo that
  owns the contract; the convention and template are canonical in
  [isomorphic-lib-template's `decisions/`](https://github.com/interop-alliance/isomorphic-lib-template/tree/main/decisions).
