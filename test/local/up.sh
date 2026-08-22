#!/usr/bin/env bash
# Brings up the local Postgres + PostgREST stack, applies the production schema,
# seeds the roster, and starts the built app against it.
set -euo pipefail
cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f test/local/docker-compose.yml"
export PGRST_JWT_SECRET="${PGRST_JWT_SECRET:-local-test-secret-that-is-at-least-32-chars}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-test-admin-pw}"
PORT="${PORT:-3100}"

echo "→ starting postgres + postgrest"
$COMPOSE up -d --wait

echo "→ applying roles and schema"
$COMPOSE exec -T db psql -U postgres -d attendance -q -f - < test/local/roles.sql
$COMPOSE exec -T db psql -U postgres -d attendance -q -f - < supabase/schema.sql
# Re-grant: the schema creates the tables after the first grant pass.
$COMPOSE exec -T db psql -U postgres -d attendance -q -f - < test/local/roles.sql
$COMPOSE exec -T db psql -U postgres -d attendance -qAtc "notify pgrst, 'reload schema';"

SERVICE_KEY="$(node test/local/jwt.mjs "$PGRST_JWT_SECRET")"

echo "→ starting rest proxy on :54321"
node test/local/proxy.mjs > /tmp/att-proxy.log 2>&1 &
echo $! > /tmp/att-proxy.pid

cat > .env.test.local <<ENV
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
ADMIN_PASSWORD=$ADMIN_PASSWORD
CLASS_TIMEZONE=Asia/Kolkata
ENV

echo "→ seeding roster"
set -a; . ./.env.test.local; set +a
npx tsx scripts/seed.ts "Soft Skills.xlsx"

echo "→ starting app on :$PORT"
npx next start -p "$PORT" > /tmp/att-app.log 2>&1 &
echo $! > /tmp/att-app.pid

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/" > /dev/null; then
    echo "→ ready at http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 1
done
echo "app did not come up; see /tmp/att-app.log" >&2
tail -20 /tmp/att-app.log >&2
exit 1
