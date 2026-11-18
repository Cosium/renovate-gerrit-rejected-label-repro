# Renovate on Gerrit: a change with Verified -1 has a yellow branch status

On Gerrit, Renovate reads the status of a change whose build failed
(`Verified -1`) as `yellow` (pending) instead of `red`, when the `Verified`
label is defined the way Gerrit documents it since submit requirements
replaced label functions: function `NoBlock`, the veto expressed by a submit
requirement. With `automerge: true` and `assignAutomerge: false`, Renovate
therefore never adds the configured reviewers to the failed change, and nobody
is told about it.

Discussion: https://github.com/renovatebot/renovate/discussions/48019
Proposed fix: https://github.com/renovatebot/renovate/pull/48020

## What happens

Gerrit marks a vote at the label's minimum value as `rejected` in the change's
`labels`. It sets `blocking` only for the deprecated `MaxWithBlock` and
`AnyWithBlock` label functions. Renovate's Gerrit `getBranchStatus` returns
`red` only for a `blocking` label, so with a `NoBlock` label the failed change
is not submittable, not blocking, and reads as `yellow`.

## Reproduction

Prerequisites: Docker with Compose v2, git, Node.js 24 or later (it runs the
TypeScript scripts directly). To run Renovate from source, also a Renovate
checkout with its dependencies installed (`pnpm install`). `RENOVATE_*` variables of your shell
are not passed to Renovate.

```sh
node scripts/run.ts released                 # renovate/renovate:44.251.0
node scripts/run.ts source ~/src/renovate    # any Renovate checkout, via pnpm start
docker compose down -v                       # clean up
```

Each invocation takes about 30 seconds once the images are pulled. It starts a
fresh Gerrit 3.14.6 (development auth, default `admin`/`secret`) and then:

1. creates the users `renovate`, `alice` and `ci`, and the project
   `rejected-label-demo` with an outdated `package.json`, a `Verified` label
   (`NoBlock`, -1..+1, voted by `ci`) and a `Verified` submit requirement
   (`label:Verified=MAX AND -label:Verified=MIN`);
2. Renovate run 1 creates a change for `is-number`. With `automerge: true` and
   `assignAutomerge: false`, it adds no reviewer while the checks are pending;
3. `ci` votes `Verified -1` on the change, as a CI account does when the build
   fails. Any account allowed to vote `Verified -1` gives the same state;
4. Renovate run 2 processes the existing change. It should see a `red` status
   and add `alice` as a reviewer. `ci` became a reviewer by voting, so it is in
   `ignoreReviewers`.

Renovate logs (debug) go to `logs/`. The script ends with `Reproduced` or
`Not reproduced`, and fails if Renovate stopped before reading the branch
status.

## Current behavior

Output with Renovate 44.251.0:

```
==> ci votes Verified -1 (the build of the change failed)
  labels.Verified: rejected set, blocking absent
  submittable: false
  submit requirement Verified: UNSATISFIED
  submit requirement Code-Review: UNSATISFIED
  submit requirement No-Unresolved-Comments: NOT_APPLICABLE

==> Branch status and reviewer decisions of run 2 (logs/released-run2.log)
  Branch status yellow
  Branch status yellow
  PR is not ready for merge (branch status is yellow)

==> Change after run 2
  reviewers: ["ci"]

==> Reproduced: Renovate did not add alice to the failed change
```

## Expected behavior

The branch status is `red` and Renovate adds `alice`. Output with the proposed
fix:

```
==> Branch status and reviewer decisions of run 2 (logs/source-259e32acd3-run2.log)
  Branch status red
  Setting assignees and reviewers as status checks failed
  Branch status red
  PR is not ready for merge (branch status is red)

==> Change after run 2
  reviewers: ["alice","ci"]

==> Not reproduced: Renovate added alice to the failed change
```

The output also shows why unsatisfied submit requirements cannot stand for
`red`: `Code-Review` is `UNSATISFIED` too, only because nobody has reviewed
the change yet.

## Files

- [`docker-compose.yml`](docker-compose.yml): Gerrit, and the released Renovate image (profile `renovate`)
- [`config.js`](config.js): self-hosted Renovate configuration for both runs
- [`project/`](project): content of the demo project's first commit
- [`scripts/run.ts`](scripts/run.ts): the whole scenario, from a clean Gerrit
