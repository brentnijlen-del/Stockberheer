#!/usr/bin/env bash
# LOCAL DISPOSABLE TEST CONTAINER ONLY. Never run on a production database.
set -euo pipefail
if [[ $# != 1 ]]; then
  echo 'Usage: bash scripts/install-test-safeupdate.sh LOCAL_TEST_CONTAINER' >&2
  exit 1
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'This pinned build requires Linux x86_64 (for example the CI runner or a Linux test VM).' >&2
  exit 1
fi
for tool in gcc curl dpkg-deb sha256sum docker; do command -v "$tool" >/dev/null; done
docker_local() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
safeupdate_container=$1
# Refuse a non-PG17 target or one without the explicit disposable test database.
safeupdate_version=$(docker_local exec "$safeupdate_container" pg_config --version)
[[ "$safeupdate_version" == 'PostgreSQL 17.'* ]]
[[ $(docker_local exec "$safeupdate_container" psql -U postgres -d material_test -Atc 'select current_database()') == material_test ]]
safeupdate_libdir=$(docker_local exec "$safeupdate_container" pg_config --pkglibdir)
mkdir -p work
safeupdate_workdir=$(mktemp -d work/safeupdate.XXXXXX)
trap 'rm -rf "$safeupdate_workdir"' EXIT
# Both source and development headers are pinned and verified. No security setting is disabled.
curl --fail --silent --show-error --location --max-time 60 \
  'https://raw.githubusercontent.com/eradman/pg-safeupdate/37dbc9c4acf5e2504adf2b218e9c6b41751022f3/safeupdate.c' \
  -o "$safeupdate_workdir/safeupdate.c"
curl --fail --silent --show-error --location --max-time 60 \
  'https://deb.debian.org/debian/pool/main/p/postgresql-17/postgresql-server-dev-17_17.11-0+deb13u1_amd64.deb' \
  -o "$safeupdate_workdir/headers.deb"
echo "1351fc18b9a1e2dcc72185d349c178244458b5d9eb30007609c3d599b38aeb38  $safeupdate_workdir/safeupdate.c" | sha256sum --check --status
echo "59cb25f0a1def045aa334a9c025befc4a72dfc72d4a370f97d7d3f7342803d7e  $safeupdate_workdir/headers.deb" | sha256sum --check --status
dpkg-deb --extract "$safeupdate_workdir/headers.deb" "$safeupdate_workdir/headers"
gcc -shared -fPIC -I"$safeupdate_workdir/headers/usr/include/postgresql/17/server" \
  -o "$safeupdate_workdir/safeupdate.so" "$safeupdate_workdir/safeupdate.c"
chmod 644 "$safeupdate_workdir/safeupdate.so"
docker_local cp "$safeupdate_workdir/safeupdate.so" "$safeupdate_container:$safeupdate_libdir/safeupdate.so"
echo 'Installed pg-safeupdate in the local test container. Test connections load it with protection enabled.'
