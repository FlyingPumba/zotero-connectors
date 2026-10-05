# Fork workflow

- Make changes to this fork on the local `main` branch.
- Before starting new changes, run `git fetch upstream main` and rebase local `main` onto `upstream/main`. Keep fork-specific commits on top instead of merging upstream into `main`.
- Preserve any uncommitted work before rebasing, and retain the fork’s existing customizations when resolving conflicts.
- The `upstream` remote is the official repository at `https://github.com/zotero/zotero-connectors.git`; `origin` is Ivan’s existing fork.
