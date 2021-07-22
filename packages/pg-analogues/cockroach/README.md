Don't forget to run `yarn watch` at the root of the repo!

To run tests against cockroach:

1. install cockroach via `./cockroach-get-nightly.sh`
2. Run cockroach in its own terminal via `./run`
3. In a different terminal:
    1. `export TEST_DATABASE_URL="postgresql://root:root@localhost:26257/pggql_test"`
    2. `export COCKROACH=1`
    3. Inside the root folder run `./scripts/pretest`
    4. Inside `packages/pg-analogues` run `yarn test`