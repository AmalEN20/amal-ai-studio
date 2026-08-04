export const D1_MAX_BOUND_PARAMETERS = 100;

export function batchD1BoundValues<T>(
  values: readonly T[],
  reservedParameters = 0,
): T[][] {
  if (
    !Number.isInteger(reservedParameters) ||
    reservedParameters < 0 ||
    reservedParameters >= D1_MAX_BOUND_PARAMETERS
  ) {
    throw new Error(
      "D1 reserved parameters must leave room for at least one value",
    );
  }

  const batchSize = D1_MAX_BOUND_PARAMETERS - reservedParameters;
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    batches.push(values.slice(index, index + batchSize));
  }
  return batches;
}

export function maxD1InsertRows(bindingsPerRow: number): number {
  if (!Number.isInteger(bindingsPerRow) || bindingsPerRow < 1) {
    throw new Error("D1 bindings per row must be a positive integer");
  }
  if (bindingsPerRow > D1_MAX_BOUND_PARAMETERS) {
    throw new Error("A single D1 row exceeds the bound-parameter limit");
  }
  return Math.floor(D1_MAX_BOUND_PARAMETERS / bindingsPerRow);
}
