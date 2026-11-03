#!/usr/bin/env bash
# Refuses to release a tag unless it's a plain version, on master, and newer than npm.
# Usage: verify-release.sh <tag> <commit> <latest-version-on-npm>
set -euo pipefail

tag="$1"
commit="$2"
latest="$3"
version="${tag#v}"

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::Tag $tag isn't a release version like 5.0.1" >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$commit" origin/master; then
  echo "::error::Tag $tag points to a commit that isn't on master" >&2
  exit 1
fi

newest="$(printf '%s\n%s\n' "$latest" "$version" | sort -V | tail -n 1)"

if [[ "$version" == "$latest" || "$newest" != "$version" ]]; then
  echo "::error::Tag $tag must be newer than $latest, the latest version on npm" >&2
  exit 1
fi

echo "$version"
