import { Plugin } from "graphile-build";
import isString = require("lodash/isString");
import { GraphQLObjectType } from "graphql";
import { SQL } from "../QueryBuilder";
import { OrderBySpec, OrderByValue } from "./PgConnectionArgOrderBy";

declare module "graphile-build" {
  interface GraphileBuildOptions {
    disableIssue397Fix?: boolean;
  }
  interface ScopeGraphQLObjectTypeFieldsField {
    isPgMutationPayloadEdgeField?: true;
  }
}

export default (function PgMutationPayloadEdgePlugin(
  builder,
  { pgSimpleCollections, disableIssue397Fix }
) {
  builder.hook(
    "GraphQLObjectType:fields",
    (fields, build, context) => {
      const {
        extend,
        getSafeAliasFromResolveInfo,
        getTypeByName,
        pgGetGqlTypeByTypeIdAndModifier,
        pgSql: sql,
        graphql: { GraphQLList, GraphQLNonNull, getNamedType, GraphQLEnumType },
        inflection,
        pgOmit: omit,
        describePgEntity,
        pgField,
      } = build;
      const {
        scope: { isMutationPayload, pgIntrospection, pgIntrospectionTable },
        fieldWithHooks,
        Self,
      } = context;

      const table = pgIntrospectionTable || pgIntrospection;
      if (
        !isMutationPayload ||
        !pgIntrospection ||
        !table ||
        table.kind !== "class" ||
        !table.namespace ||
        !table.isSelectable ||
        (omit(table, "all") && omit(table, "many"))
      ) {
        return fields;
      }
      if (
        pgIntrospection.kind === "procedure" &&
        (pgIntrospection.returnTypeId !== table.typeId ||
          pgIntrospection.returnsSet)
      ) {
        return fields;
      }
      const simpleCollections =
        table.tags.simpleCollections || pgSimpleCollections;
      const hasConnections = simpleCollections !== "only";
      if (!hasConnections && !disableIssue397Fix) {
        return fields;
      }

      const TableType = pgGetGqlTypeByTypeIdAndModifier(table.type.id, null);
      if (!TableType) {
        return fields;
      }
      const tableTypeName = getNamedType(TableType).name;
      const TableOrderByType = getTypeByName(
        inflection.orderByType(tableTypeName)
      );
      if (!TableOrderByType || !(TableOrderByType instanceof GraphQLEnumType)) {
        return fields;
      }

      const TableEdgeType = getTypeByName(inflection.edge(tableTypeName));
      if (!TableEdgeType || !(TableEdgeType instanceof GraphQLObjectType)) {
        return fields;
      }

      const primaryKeyConstraint = table.primaryKeyConstraint;
      const primaryKeys =
        primaryKeyConstraint && primaryKeyConstraint.keyAttributes;
      const canOrderBy = !omit(table, "order");

      const fieldName = inflection.edgeField(table);
      const defaultValueEnum =
        canOrderBy &&
        (TableOrderByType.getValues().find(v => v.name === "PRIMARY_KEY_ASC") ||
          TableOrderByType.getValues()[0]);
      return extend(
        fields,
        {
          [fieldName]: pgField(
            build,
            fieldWithHooks,
            fieldName,
            {
              description: `An edge for our \`${tableTypeName}\`. May be used by Relay 1.`,
              type: TableEdgeType,
              args: canOrderBy
                ? {
                    orderBy: {
                      description: `The method to use when ordering \`${tableTypeName}\`.`,
                      type: new GraphQLList(
                        new GraphQLNonNull(TableOrderByType)
                      ),

                      defaultValue: defaultValueEnum
                        ? [defaultValueEnum.value]
                        : null,
                    },
                  }
                : {},
              resolve(data, { orderBy: rawOrderBy }, _context, resolveInfo) {
                if (!data.data) {
                  return null;
                }
                const safeAlias = getSafeAliasFromResolveInfo(resolveInfo);
                const edge = data.data[safeAlias];
                if (!edge) {
                  return null;
                }
                const orderBy =
                  canOrderBy && rawOrderBy
                    ? Array.isArray(rawOrderBy)
                      ? rawOrderBy
                      : [rawOrderBy]
                    : null;
                const order =
                  orderBy && orderBy.some(item => item.alias)
                    ? orderBy.filter(item => item.alias)
                    : null;

                if (!order) {
                  if (edge.__identifiers) {
                    return {
                      ...edge,
                      __cursor: ["primary_key_asc", edge.__identifiers],
                    };
                  } else {
                    return edge;
                  }
                }

                return {
                  ...edge,
                  __cursor:
                    edge[`__order_${order.map(item => item.alias).join("__")}`],
                };
              },
            },

            {
              isPgMutationPayloadEdgeField: true,
              pgFieldIntrospection: table,
            },

            false,
            {
              withQueryBuilder(queryBuilder, { parsedResolveInfoFragment }) {
                const {
                  args: { orderBy: rawOrderBy },
                } = parsedResolveInfoFragment;
                const orderBy: OrderByValue[] | null =
                  canOrderBy && rawOrderBy
                    ? Array.isArray(rawOrderBy)
                      ? rawOrderBy
                      : [rawOrderBy]
                    : null;
                if (orderBy != null) {
                  const aliases: string[] = [];
                  const expressions: SQL[] = [];
                  let unique = false;
                  orderBy.forEach(item => {
                    const { alias, specs, unique: itemIsUnique } = item;
                    unique = unique || itemIsUnique || false;
                    const orders = Array.isArray(specs[0]) ? specs : [specs];
                    orders.forEach(([col, _ascending]) => {
                      if (!col) {
                        return;
                      }
                      const expr = isString(col)
                        ? sql.fragment`${queryBuilder.getTableAlias()}.${sql.identifier(
                            col
                          )}`
                        : col;
                      expressions.push(expr);
                    });
                    if (alias == null) return;
                    aliases.push(alias);
                  });
                  if (!unique && primaryKeys) {
                    // Add PKs
                    primaryKeys.forEach(key => {
                      expressions.push(
                        sql.fragment`${queryBuilder.getTableAlias()}.${sql.identifier(
                          key.name
                        )}`
                      );
                    });
                  }
                  if (aliases.length) {
                    queryBuilder.select(
                      sql.fragment`json_build_array(${sql.join(
                        aliases.map(a => sql.fragment`${sql.literal(a)}::text`),
                        ", "
                      )}, json_build_array(${sql.join(expressions, ", ")}))`,
                      "__order_" + aliases.join("__")
                    );
                  }
                }
              },
            }
          ),
        },

        `Adding edge field for table ${describePgEntity(
          table
        )} to mutation payload '${Self.name}'`
      );
    },
    ["PgMutationPayloadEdge"]
  );
} as Plugin);