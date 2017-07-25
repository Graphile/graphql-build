// @flow
import * as sql from "pg-sql2";
import type { SQL } from "pg-sql2";
import isSafeInteger from "lodash/isSafeInteger";

const isDev = ["test", "development"].indexOf(process.env.NODE_ENV) >= 0;

type Gen<T> = () => T;

function callIfNecessary<T>(o: Gen<T> | T): T {
  if (typeof o === "function") {
    return o();
  } else {
    return o;
  }
}

function callIfNecessaryArray<T>(o: Array<Gen<T> | T>): Array<T> {
  if (Array.isArray(o)) {
    return o.map(callIfNecessary);
  } else {
    return o;
  }
}

type RawAlias = Symbol | string;
type SQLAlias = SQL;
type SQLGen = Gen<SQL> | SQL;
type CursorValue = {};
type CursorComparator = (val: CursorValue, isAfter: boolean) => SQL;

class QueryBuilder {
  locks: {
    [string]: true | string,
  };
  finalized: boolean;
  data: {
    cursorPrefix: Array<string>,
    select: Array<[SQLGen, RawAlias]>,
    selectCursor: ?SQLGen,
    from: ?[SQLGen, SQLAlias],
    join: Array<SQLGen>,
    where: Array<SQLGen>,
    whereBound: {
      lower: Array<SQLGen>,
      upper: Array<SQLGen>,
    },
    orderBy: Array<[SQLGen, boolean]>,
    orderIsUnique: boolean,
    limit: ?number,
    offset: ?number,
    flip: boolean,
    beforeLock: {
      [string]: () => void,
    },
    cursorComparator: ?CursorComparator,
  };
  compiledData: {
    cursorPrefix: Array<string>,
    select: Array<[SQL, RawAlias]>,
    selectCursor: ?SQL,
    from: ?[SQL, SQLAlias],
    join: Array<SQL>,
    where: Array<SQL>,
    whereBound: {
      lower: Array<SQL>,
      upper: Array<SQL>,
    },
    orderBy: Array<[SQL, boolean]>,
    orderIsUnique: boolean,
    limit: ?number,
    offset: ?number,
    flip: boolean,
    cursorComparator: ?CursorComparator,
  };

  constructor() {
    this.locks = {};
    this.finalized = false;
    this.data = {
      // TODO: refactor `cursorPrefix`, it shouldn't be here (or should at least have getters/setters)
      cursorPrefix: ["natural"],
      select: [],
      selectCursor: null,
      from: null,
      join: [],
      where: [],
      whereBound: {
        lower: [],
        upper: [],
      },
      orderBy: [],
      orderIsUnique: false,
      limit: null,
      offset: null,
      flip: false,
      beforeLock: {},
      cursorComparator: null,
    };
    this.compiledData = {
      cursorPrefix: ["natural"],
      select: [],
      selectCursor: null,
      from: null,
      join: [],
      where: [],
      whereBound: {
        lower: [],
        upper: [],
      },
      orderBy: [],
      orderIsUnique: false,
      limit: null,
      offset: null,
      flip: false,
      cursorComparator: null,
    };
    this.beforeLock("select", () => {
      this.lock("selectCursor");
      if (this.compiledData.selectCursor) {
        this.select(this.compiledData.selectCursor, "__cursor");
      }
    });
    this.beforeLock("where", () => {
      this.lock("whereBound");
    });
  }

  // ----------------------------------------

  beforeLock(field: string, fn: () => void) {
    this.checkLock(field);
    this.data.beforeLock[field] = this.data.beforeLock[field] || [];
    this.data.beforeLock[field].push(fn);
  }
  setCursorComparator(fn: CursorComparator) {
    this.checkLock("cursorComparator");
    this.data.cursorComparator = fn;
    this.lock("cursorComparator");
  }
  cursorCondition(cursorValue: CursorValue, isAfter: boolean) {
    this.lock("cursorComparator");
    if (!this.compiledData.cursorComparator) {
      throw new Error("No cursor comparator was set!");
    }
    return this.compiledData.cursorComparator(cursorValue, isAfter);
  }
  select(exprGen: SQLGen, alias: RawAlias) {
    this.checkLock("select");
    this.data.select.push([exprGen, alias]);
  }
  selectCursor(exprGen: SQLGen) {
    this.checkLock("selectCursor");
    this.data.selectCursor = exprGen;
  }
  from(expr: SQLGen, alias: SQLAlias = sql.identifier(Symbol())) {
    this.checkLock("from");
    if (!expr) {
      throw new Error("No from table source!");
    }
    if (!alias) {
      throw new Error("No from alias!");
    }
    this.data.from = [expr, alias];
    this.lock("from");
  }
  // XXX: join
  where(exprGen: SQLGen) {
    this.checkLock("where");
    this.data.where.push(exprGen);
  }
  whereBound(exprGen: SQLGen, isLower: boolean) {
    if (typeof isLower !== "boolean") {
      throw new Error("isLower must be specified as a boolean");
    }
    this.checkLock("whereBound");
    this.data.whereBound[isLower ? "lower" : "upper"].push(exprGen);
  }
  setOrderIsUnique() {
    this.data.orderIsUnique = true;
  }
  orderBy(exprGen: SQLGen, ascending: boolean = true) {
    this.checkLock("orderBy");
    this.data.orderBy.push([exprGen, ascending]);
  }
  limit(limit: number) {
    this.checkLock("limit");
    this.data.limit = Math.max(0, limit);
    this.lock("limit");
  }
  offset(offset: number) {
    this.checkLock("offset");
    this.data.offset = Math.max(0, offset);
    this.lock("offset");
  }
  flip() {
    this.checkLock("flip");
    this.data.flip = true;
    this.lock("flip");
  }

  // ----------------------------------------

  isOrderUnique() {
    this.lock("orderIsUnique");
    return this.compiledData.orderIsUnique;
  }
  getTableAlias(): SQL {
    this.lock("from");
    if (!this.compiledData.from) {
      throw new Error("No from table has been supplied");
    }
    return this.compiledData.from[1];
  }
  getSelectCursor() {
    this.lock("selectCursor");
    return this.compiledData.selectCursor;
  }
  getOffset() {
    this.lock("offset");
    return this.compiledData.offset || 0;
  }
  getOrderByExpressionsAndDirections() {
    this.lock("orderBy");
    return this.compiledData.orderBy;
  }
  buildSelectFields() {
    this.lockEverything();
    return sql.join(
      this.compiledData.select.map(
        ([sqlFragment, alias]) =>
          sql.fragment`${sqlFragment} as ${sql.identifier(alias)}`
      ),
      ", "
    );
  }
  buildSelectJson({ addNullCase }: { addNullCase?: boolean }) {
    this.lockEverything();
    let buildObject = this.compiledData.select.length
      ? sql.fragment`json_build_object(${sql.join(
          this.compiledData.select.map(
            ([sqlFragment, alias]) =>
              sql.fragment`${sql.literal(alias)}, ${sqlFragment}`
          ),
          ", "
        )})`
      : sql.fragment`to_json(${this.getTableAlias()}.*)`;
    if (addNullCase) {
      buildObject = sql.fragment`(case when ${this.getTableAlias()} is null then null else ${buildObject} end)`;
    }
    return buildObject;
  }
  buildWhereBoundClause(isLower: boolean) {
    this.lock("whereBound");
    const clauses = this.compiledData.whereBound[isLower ? "lower" : "upper"];
    if (clauses.length) {
      return sql.fragment`(${sql.join(clauses, ") and (")})`;
    } else {
      return sql.literal(true);
    }
  }
  buildWhereClause(
    includeLowerBound: boolean,
    includeUpperBound: boolean,
    { addNullCase }: { addNullCase?: boolean }
  ) {
    this.lock("where");
    const clauses = [
      ...(addNullCase
        ? /*
           * Okay... so this is quite interesting. When we're talking about
           * composite types, `(foo is not null)` and `not (foo is null)` are
           * NOT equivalent! Here's why:
           *
           * `(foo is null)`
           *   true if every field of the row is null
           *
           * `(foo is not null)`
           *   true if every field of the row is not null
           *
           * `not (foo is null)`
           *   true if there's at least one field that is not null
           *
           * So don't "simplify" the line below! We're probably checking if
           * the result of a function call returning a compound type was
           * indeed null.
           */
          [sql.fragment`not (${this.getTableAlias()} is null)`]
        : []),
      ...this.compiledData.where,
      ...(includeLowerBound ? [this.buildWhereBoundClause(true)] : []),
      ...(includeUpperBound ? [this.buildWhereBoundClause(false)] : []),
    ];
    return clauses.length
      ? sql.fragment`(${sql.join(clauses, ") and (")})`
      : sql.fragment`1 = 1`;
  }
  build(
    options: {
      asJson?: boolean,
      asJsonAggregate?: boolean,
      onlyJsonField?: boolean,
      addNullCase?: boolean,
    } = {}
  ) {
    const {
      asJson = false,
      asJsonAggregate = false,
      onlyJsonField = false,
      addNullCase = false,
    } = options;

    this.lockEverything();
    if (onlyJsonField) {
      return this.buildSelectJson({ addNullCase });
    }
    const fields =
      asJson || asJsonAggregate
        ? sql.fragment`${this.buildSelectJson({ addNullCase })} as object`
        : this.buildSelectFields();
    let fragment = sql.fragment`
      select ${fields}
      ${this.compiledData.from &&
        sql.fragment`from ${this.compiledData
          .from[0]} as ${this.getTableAlias()}`}
      ${this.compiledData.join.length && sql.join(this.compiledData.join, " ")}
      where ${this.buildWhereClause(true, true, options)}
      ${this.compiledData.orderBy.length
        ? sql.fragment`order by ${sql.join(
            this.compiledData.orderBy.map(
              ([expr, ascending]) =>
                sql.fragment`${expr} ${Number(ascending) ^
                Number(this.compiledData.flip)
                  ? sql.fragment`ASC`
                  : sql.fragment`DESC`}`
            ),
            ","
          )}`
        : ""}
      ${isSafeInteger(this.compiledData.limit) &&
        sql.fragment`limit ${sql.literal(this.compiledData.limit)}`}
      ${this.compiledData.offset &&
        sql.fragment`offset ${sql.literal(this.compiledData.offset)}`}
    `;
    if (this.compiledData.flip) {
      const flipAlias = Symbol();
      fragment = sql.fragment`
        with ${sql.identifier(flipAlias)} as (
          ${fragment}
        )
        select *
        from ${sql.identifier(flipAlias)}
        order by (row_number() over (partition by 1)) desc
        `;
    }
    if (asJsonAggregate) {
      const aggAlias = Symbol();
      fragment = sql.fragment`select json_agg(${sql.identifier(
        aggAlias,
        "object"
      )}) from (${fragment}) as ${sql.identifier(aggAlias)}`;
      fragment = sql.fragment`select coalesce((${fragment}), '[]'::json)`;
    }
    return fragment;
  }

  // ----------------------------------------

  _finalize() {
    this.finalized = true;
  }
  lock(type: string) {
    if (this.locks[type]) return;
    for (const fn of this.data.beforeLock[type] || []) {
      fn();
    }
    this.locks[type] = isDev ? new Error("Initally locked here").stack : true;
    if (type === "cursorComparator") {
      // It's meant to be a function
    } else if (type === "whereBound") {
      // Handle properties separately
      this.compiledData[type].lower = callIfNecessaryArray(
        this.data[type].lower
      );
      this.compiledData[type].upper = callIfNecessaryArray(
        this.data[type].upper
      );
    } else if (type === "select") {
      this.compiledData[type] = this.data[type].map(([a, b]) => [
        callIfNecessary(a),
        b,
      ]);
    } else if (type === "orderBy") {
      this.compiledData[type] = this.data[type].map(([a, b]) => [
        callIfNecessary(a),
        b,
      ]);
    } else if (type === "from") {
      if (this.data.from) {
        const f = this.data.from;
        this.compiledData.from = [callIfNecessary(f[0]), f[1]];
      }
    } else if (type === "join" || type === "where") {
      this.compiledData[type] = callIfNecessaryArray(this.data[type]);
    } else if (type === "selectCursor") {
      this.compiledData[type] = callIfNecessary(this.data[type]);
    } else if (type === "cursorPrefix") {
      this.compiledData[type] = this.data[type];
    } else if (type === "orderIsUnique") {
      this.compiledData[type] = this.data[type];
    } else if (type === "limit") {
      this.compiledData[type] = this.data[type];
    } else if (type === "offset") {
      this.compiledData[type] = this.data[type];
    } else if (type === "flip") {
      this.compiledData[type] = this.data[type];
    } else {
      throw new Error(`Wasn't expecting to lock '${type}'`);
    }
  }
  checkLock(type: string) {
    if (this.locks[type]) {
      if (typeof this.locks[type] === "string") {
        throw new Error(
          `'${type}' has already been locked\n    ` +
            this.locks[type].replace(/\n/g, "\n    ") +
            "\n"
        );
      }
      throw new Error(`'${type}' has already been locked`);
    }
  }
  lockEverything() {
    this._finalize();
    // We must execute everything after `from` so we have the alias to reference
    this.lock("from");
    this.lock("flip");
    this.lock("join");
    this.lock("offset");
    this.lock("limit");
    this.lock("orderBy");
    // We must execute where after orderBy because cursor queries require all orderBy columns
    this.lock("cursorComparator");
    this.lock("where");
    // We must execute select after orderBy otherwise we cannot generate a cursor
    this.lock("selectCursor");
    this.lock("select");
  }
}

export default QueryBuilder;
