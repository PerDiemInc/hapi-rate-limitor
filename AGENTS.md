# hapi-rate-limitor

Rate limiting plugin for hapi, backed by Redis or Valkey. See `README.md` for what it does.

## Releasing

**Pushing a version tag publishes to npm. That can't be undone, so never push one unless asked.**

```sh
git switch master && git pull
git tag 5.0.1
git push origin 5.0.1
```

- The tag sets the published version, so don't commit a version bump to release. `package.json` in the repo can lag behind npm.
- Tags look like `5.0.1` or `v5.0.1`. Other tags don't trigger the workflow, including `5.0.1-beta.1`.
- `.github/workflows/publish-npm.yml` refuses a tag that isn't on `master` or isn't newer than npm's latest version. It then runs lint, audit and tests before publishing, and creates the GitHub Release.
- Merging to `master` never publishes.
- The publish step waits for approval from a reviewer on the `npm-publish` environment, or an admin. Don't approve it unless asked.
- If the publish succeeded but the GitHub Release step failed, don't re-run: the version already exists on npm. Create the release by hand.
- Add the release to `CHANGELOG.md` in a PR before tagging.
- A published version can't be reused. Ship fixes as a new version.

## Rules

- **No runtime dependencies.** Every package added can run code in the API. Don't add one without asking.
- **`redis` is a client the caller passes in.** This package doesn't create or close connections.
- **A Redis failure must not fail requests**, unless the route chooses `onStoreError: "closed"`.
- **Keep `src/store/redis.ts` and `src/store/memory.ts` in step.** A test compares them over random traffic.
- **Never store phone numbers or emails in Redis keys.** `by` values are hashed.
- **This repo is public.** Don't put internal hostnames, secrets or details of vulnerabilities in other Per Diem services in code, PRs or issues.

## Checks

Tests need Redis on `localhost:6379`, or set `REDIS_URL`. Use a throwaway instance.

```sh
npm run lint   # Biome and TypeScript
npm test       # builds first, needs 95% line coverage
```

Use conventional commits, like `fix: handle empty header`.
