#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
for f in /tmp/att-app.pid /tmp/att-proxy.pid; do
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"
done
docker compose -f test/local/docker-compose.yml down -v
rm -f .env.test.local
