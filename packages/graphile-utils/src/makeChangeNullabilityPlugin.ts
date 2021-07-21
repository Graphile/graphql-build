import type {
  Build,
  Context,
  Options,
  Plugin,
  SchemaBuilder,
} from "graphile-build";
import {
  GraphQLFieldConfig,
  GraphQLInputFieldConfig,
  GraphQLInputType,
  GraphQLNonNull,
  GraphQLType,
} from "graphql";
import { GraphQLList } from "graphql/type/definition";

interface NullabilityOpts {
  type?: boolean | boolean[];
  args?: {
    [argName: string]: boolean | boolean[];
  };
}

interface ChangeNullabilityRules {
  [typeName: string]: {
    [fieldName: string]: boolean | boolean[] | NullabilityOpts;
  };
}

export default function makeChangeNullabilityPlugin(
  rules: ChangeNullabilityRules
): Plugin {
  return (builder: SchemaBuilder, _options: Options) => {
    function applyNullability<Type extends GraphQLType | GraphQLInputType>(
      type: Type,
      allNullabilities: boolean[]
    ): Type {
      const [nullability, ...rest] = allNullabilities;
      const nullableType = type instanceof GraphQLNonNull ? type.ofType : type;
      let inner = null;
      if (nullableType instanceof GraphQLList) {
        inner = new GraphQLList(applyNullability(nullableType.ofType, rest));
      } else {
        if (rest.length > 0) {
          throw new Error(`Too many booleans passed`);
        }
        inner = nullableType;
      }
      return nullability
        ? inner
        : inner === type
        ? new GraphQLNonNull(inner)
        : type; // Optimisation if it's already non-null*/;
    }
    function applyTypeNullability<Type extends GraphQLType | GraphQLInputType>(
      type: Type,
      shouldBeNullable: boolean | boolean[]
    ): Type {
      const allNullabilities: boolean[] =
        shouldBeNullable instanceof Array
          ? shouldBeNullable
          : [shouldBeNullable];
      return allNullabilities.length > 0
        ? applyNullability(type, allNullabilities)
        : type;
    }
    function changeNullability<
      Field extends GraphQLInputFieldConfig | GraphQLFieldConfig<any, any>
    >(field: Field, build: Build, context: Context<Field>): typeof field {
      const {
        Self,
        scope: { fieldName },
      } = context;
      const typeName = Self.name;
      const typeRules = rules[typeName];
      if (!typeRules) {
        return field;
      }
      const shouldBeNullable = typeRules[fieldName];
      if (shouldBeNullable == null) {
        return field;
      }
      const shouldApplyNullabilities: NullabilityOpts = {};
      if (
        typeof shouldBeNullable === "object" &&
        !(shouldBeNullable instanceof Array)
      ) {
        shouldApplyNullabilities.type = shouldBeNullable.type;
        shouldApplyNullabilities.args = shouldBeNullable.args;
      } else {
        shouldApplyNullabilities.type = shouldBeNullable;
      }
      const updatedField = { ...field };
      try {
        if (shouldApplyNullabilities.type) {
          updatedField.type = applyTypeNullability(
            field.type,
            shouldApplyNullabilities.type
          );
        }
        if (shouldApplyNullabilities.args) {
          Object.entries(shouldApplyNullabilities.args).forEach(
            ([argName, argShouldBeNullable]) => {
              if (!("args" in field) || !field.args?.[argName]) return;
              const argType = field.args[argName].type;
              field.args[argName].type = applyTypeNullability(
                argType,
                argShouldBeNullable
              );
            }
          );
        }
      } catch (err) {
        throw new Error(
          `makeChangeNullabilityPlugin. For ${typeName} > ${fieldName}: ${err.message}`
        );
      }
      return updatedField;
    }
    builder.hook("GraphQLInputObjectType:fields:field", changeNullability);
    builder.hook("GraphQLObjectType:fields:field", changeNullability);
  };
}
