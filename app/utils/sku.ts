export function normalizeSku(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

export function skuMatchesSearch(
  sku: string | null | undefined,
  query: string,
): boolean {
  const normalizedQuery = normalizeSku(query);
  if (!normalizedQuery) return true;
  return normalizeSku(sku).includes(normalizedQuery);
}

export function pickCanonicalProduct<
  T extends { id: string; sku: string; createdAt: Date },
>(products: T[], normalizedSku: string): T {
  const exactMatch = products.find((product) => product.sku === normalizedSku);
  if (exactMatch) return exactMatch;

  return [...products].sort((a, b) => {
    const createdAtDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (createdAtDiff !== 0) return createdAtDiff;
    return a.id.localeCompare(b.id);
  })[0];
}

export function mergeProductFields<
  T extends {
    name: string;
    category: string | null;
    notes: string | null;
    active: boolean;
  },
>(canonical: T, duplicates: T[]): T & { active: boolean } {
  let name = canonical.name;
  let category = canonical.category;
  let notes = canonical.notes;
  let active = canonical.active;

  for (const duplicate of duplicates) {
    if (!name?.trim() && duplicate.name?.trim()) {
      name = duplicate.name;
    }
    if (!category?.trim() && duplicate.category?.trim()) {
      category = duplicate.category;
    }
    if (!notes?.trim() && duplicate.notes?.trim()) {
      notes = duplicate.notes;
    }
    if (duplicate.active) {
      active = true;
    }
  }

  return {
    ...canonical,
    name,
    category,
    notes,
    active,
  };
}
