# Contributing Guidelines

## Code of Conduct

This project is intended to be a safe, welcoming space for collaboration. All contributors are expected to adhere to the [Contributor Covenant](https://contributor-covenant.org) code of conduct. Thank you for being kind to each other!

## Contributions Welcome

This project welcomes any kind of contribution! Here are a few suggestions:

- Ideas: participate in an issue thread or start your own to have your voice heard.
- Writing: contribute your expertise in an area by helping expand the included content.
- Copy editing: fix typos, clarify language, and generally improve the quality of documentation.
- Bug fixes: help maintain and improve the project codebase.
- Features: help expand the project's capabilities.

Before starting work on a contribution, please search issues and pull request history to avoid duplicating efforts and conversations.

When working on a new feature, open an issue to gather feedback first.

## Coding Guidelines

- Commits should be atomic and adhere to [conventional commit](https://conventionalcommits.org) standards.
- Commit messages should be short (`<topic>: <action>`, 50 char max), and commit bodies only included when necessary for complex changes (72 char max).
- Breaking changes are discouraged, and require a `BREAKING CHANGE:` footer in the commit body explaining the change.
- Types and interfaces should be inlined unless they're absolutely necessary for exporting or testing.
- Avoid unnecessary code comments, and keep necessary ones trim.
- All changes should maintain the test coverage gate (100% on covered modules).
