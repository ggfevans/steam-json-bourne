# Contributing

Thanks for your interest in contributing to this project.

## Reporting Bugs

Open a [GitHub issue](https://github.com/ggfevans/steam-json-bourne/issues/new) with:

- What you expected to happen
- What actually happened
- Your workflow configuration (redact secrets)
- Any relevant log output from the action run

## Suggesting Features

Open an issue describing the use case. This action is intentionally minimal -- it fetches data from Steam and writes JSON. Features that add complexity without broad utility may not be accepted.

## Submitting Pull Requests

1. Fork the repository and create a branch from `main`
2. Make your changes
3. Run `npm run build` and commit the updated `dist/` directory
4. Open a PR against `main` with a clear description of what changed and why

Keep PRs focused on a single change. If you're fixing a bug and also want to refactor something, open separate PRs.

## Development Setup

You need:

- **Node.js** (see `.nvmrc` for version)
- **npm**

```bash
npm install
npm run build
```

### Code Style

- Use ES module imports
- Keep the action focused on its core purpose
- Test changes locally before submitting

## Security Issues

Do not open public issues for security vulnerabilities. See [SECURITY.md](SECURITY.md) for reporting instructions.

## Licence

By contributing, you agree that your contributions will be licenced under the MIT Licence.
