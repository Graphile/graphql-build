#!/usr/bin/env bash
set -e
# https://binaries.cockroachdb.com/cockroach-v21.1.6.darwin-10.9-amd64.tgz
# curl -LO https://edge-binaries.cockroachdb.com/cockroach/cockroach.linux-gnu-amd64.LATEST
curl -o cockroach.LATEST -L https://edge-binaries.cockroachdb.com/cockroach/cockroach.darwin-amd64.LATEST
chmod +x cockroach.LATEST
./cockroach.LATEST version
