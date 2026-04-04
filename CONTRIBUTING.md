# Contributing

## Development setup

```bash
npm install
npm link
```

### Release flow

- Push conventional commits to `main` such as `feat: ...` and `fix: ...`.
- `.github/workflows/release-please.yml` opens or updates the release PR.
- Merging that PR creates the tag and GitHub Release.
- The existing publish workflow then publishes the package to npm from the `release.published` event.
