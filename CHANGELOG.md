# Changelog

## 5.0.0

Full rewrite with no runtime dependencies. See "Upgrading from 4.x" in the README for the breaking changes.

- Exact sliding windows using the Redis clock, with several limits per route applied atomically
- `by` limits per phone number, prefix or store, and `consume` for counting real sends
- `authFailures` lockouts and `earlyLimit` before authentication
- Bounded Redis waits, a circuit breaker and `onStoreError` policies, so a Redis outage doesn't fail requests
- `redis` must now be a client you pass in
- Client IP comes from `CloudFront-Viewer-Address` or `ipSources`, not from any forwarding header

Earlier versions were forked from Future Studio's [hapi-rate-limitor](https://github.com/futurestudio/hapi-rate-limitor), and their history is in the `v4.0.2` tag.
