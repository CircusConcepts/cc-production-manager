import { Prisma } from "@prisma/client";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import db from "../db.server";
import { createAuditLog } from "../services/audit.server";
import { assignProductToCategory } from "../services/productCategory.server";
import { findConflictingProduct } from "../services/productSku.server";
import { getOrCreateShop } from "../services/shop.server";
import { normalizeSku, skuMatchesSearch } from "../utils/sku";
import { authenticate } from "../shopify.server";

type ActionResult = { error?: string; success?: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const [products, productCategories, colors] = await Promise.all([
    db.product.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
      include: {
        productCategory: { select: { id: true, name: true } },
        items: {
          where: { status: "IN_STOCK" },
          select: { id: true },
        },
        _count: { select: { items: true } },
      },
    }),
    db.productCategory.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
      include: {
        _count: { select: { products: true } },
        products: {
          select: { sku: true, name: true },
          orderBy: { sku: "asc" },
        },
      },
    }),
    db.color.findMany({
      where: { shopId: shop.id },
      orderBy: { name: "asc" },
      include: {
        _count: { select: { items: true } },
      },
    }),
  ]);

  return {
    products: products.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      productCategoryId: product.productCategoryId,
      productCategoryName: product.productCategory?.name ?? null,
      notes: product.notes,
      active: product.active,
      inStockCount: product.items.length,
      itemCount: product._count.items,
      updatedAt: product.updatedAt.toISOString(),
    })),
    productCategories: productCategories.map((category) => ({
      id: category.id,
      name: category.name,
      notes: category.notes,
      active: category.active,
      productCount: category._count.products,
      assignedSkus: category.products.map((product) => product.sku).join(", "),
      updatedAt: category.updatedAt.toISOString(),
    })),
    colors: colors.map((color) => ({
      id: color.id,
      name: color.name,
      hex: color.hex,
      active: color.active,
      itemCount: color._count.items,
      updatedAt: color.updatedAt.toISOString(),
    })),
  };
};

async function resolveProductCategory(
  shopId: string,
  productCategoryId: string,
): Promise<
  | { productCategoryId: string | null; categoryName: string | null }
  | { error: string }
> {
  const categoryId = productCategoryId.trim();
  if (!categoryId) {
    return { productCategoryId: null, categoryName: null };
  }

  const category = await db.productCategory.findFirst({
    where: { id: categoryId, shopId },
    select: { id: true, name: true },
  });

  if (!category) {
    return { error: "Product category not found." };
  }

  return {
    productCategoryId: category.id,
    categoryName: category.name,
  };
}

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "create") {
    const normalizedSku = normalizeSku(String(formData.get("sku") ?? ""));
    const name = String(formData.get("name") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const active = formData.get("active") === "on";
    const productCategoryIdRaw = String(formData.get("productCategoryId") ?? "");

    if (!normalizedSku) return { error: "SKU is required." };
    if (!name) return { error: "Name is required." };

    const categoryResult = await resolveProductCategory(
      shop.id,
      productCategoryIdRaw,
    );
    if ("error" in categoryResult) return categoryResult;

    const conflict = await findConflictingProduct(shop.id, normalizedSku);
    if (conflict) {
      return {
        error: `A product with SKU ${normalizedSku} already exists.`,
      };
    }

    try {
      const product = await db.product.create({
        data: {
          shopId: shop.id,
          sku: normalizedSku,
          name,
          productCategoryId: categoryResult.productCategoryId,
          category: categoryResult.categoryName,
          notes: notes || null,
          active,
        },
      });

      await createAuditLog({
        shopId: shop.id,
        action: "product.created",
        entity: "Product",
        entityId: product.id,
        metadata: {
          sku: normalizedSku,
          name,
          productCategoryId: categoryResult.productCategoryId,
          category: categoryResult.categoryName,
        },
      });

      if (categoryResult.productCategoryId) {
        await createAuditLog({
          shopId: shop.id,
          action: "product.assigned_to_category",
          entity: "Product",
          entityId: product.id,
          metadata: {
            sku: normalizedSku,
            categoryId: categoryResult.productCategoryId,
          },
        });
      }

      return {
        success: `Product "${normalizedSku}" created. This does not affect Shopify.`,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `A product with SKU ${normalizedSku} already exists.`,
        };
      }
      throw error;
    }
  }

  if (intent === "toggleActive") {
    const productId = String(formData.get("productId") ?? "");

    const product = await db.product.findFirst({
      where: { id: productId, shopId: shop.id },
    });

    if (!product) {
      return { error: "Product not found." };
    }

    await db.product.update({
      where: { id: product.id },
      data: { active: !product.active },
    });

    return {
      success: `Product "${product.sku}" marked ${product.active ? "inactive" : "active"}. This does not affect Shopify.`,
    };
  }

  if (intent === "updateProduct") {
    const productId = String(formData.get("productId") ?? "");
    const normalizedSku = normalizeSku(String(formData.get("sku") ?? ""));
    const name = String(formData.get("name") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const active = formData.get("active") === "on";
    const productCategoryIdRaw = String(formData.get("productCategoryId") ?? "");

    if (!normalizedSku) return { error: "SKU is required." };
    if (!name) return { error: "Name is required." };

    const product = await db.product.findFirst({
      where: { id: productId, shopId: shop.id },
    });

    if (!product) return { error: "Product not found." };

    const categoryResult = await resolveProductCategory(
      shop.id,
      productCategoryIdRaw,
    );
    if ("error" in categoryResult) return categoryResult;

    const conflict = await findConflictingProduct(
      shop.id,
      normalizedSku,
      product.id,
    );
    if (conflict) {
      return {
        error: `A product with SKU ${normalizedSku} already exists.`,
      };
    }

    const before = {
      sku: product.sku,
      name: product.name,
      productCategoryId: product.productCategoryId,
      category: product.category,
      notes: product.notes,
      active: product.active,
    };

    const nextCategoryId = categoryResult.productCategoryId;
    const categoryChanged = product.productCategoryId !== nextCategoryId;

    try {
      if (categoryChanged) {
        await assignProductToCategory({
          shopId: shop.id,
          productId: product.id,
          categoryId: nextCategoryId,
          previousCategoryId: product.productCategoryId,
        });
      }

      const updated = await db.product.update({
        where: { id: product.id },
        data: {
          sku: normalizedSku,
          name,
          notes: notes || null,
          active,
          ...(categoryChanged
            ? {}
            : {
                productCategoryId: nextCategoryId,
                category: categoryResult.categoryName,
              }),
        },
      });

      await createAuditLog({
        shopId: shop.id,
        action: "product.updated",
        entity: "Product",
        entityId: product.id,
        metadata: {
          before,
          after: {
            sku: updated.sku,
            name: updated.name,
            productCategoryId: updated.productCategoryId,
            category: updated.category,
            notes: updated.notes,
            active: updated.active,
          },
        },
      });

      return {
        success: `Product "${normalizedSku}" updated. This does not affect Shopify.`,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `A product with SKU ${normalizedSku} already exists.`,
        };
      }
      throw error;
    }
  }

  if (intent === "deleteProduct") {
    const productId = String(formData.get("productId") ?? "");

    const product = await db.product.findFirst({
      where: { id: productId, shopId: shop.id },
      include: { _count: { select: { items: true } } },
    });

    if (!product) return { error: "Product not found." };

    if (product._count.items > 0) {
      return {
        error:
          'Cannot delete this product because it has list items. Use "Delete product + local list items" instead.',
      };
    }

    await createAuditLog({
      shopId: shop.id,
      action: "product.deleted",
      entity: "Product",
      entityId: product.id,
      metadata: {
        sku: product.sku,
        name: product.name,
        category: product.category,
        deletedItemCount: 0,
      },
    });

    await db.product.delete({ where: { id: product.id } });

    return {
      success: `Product "${product.sku}" deleted from app database. This does not affect Shopify.`,
    };
  }

  if (intent === "deleteProductWithItems") {
    const productId = String(formData.get("productId") ?? "");

    const product = await db.product.findFirst({
      where: { id: productId, shopId: shop.id },
      include: { _count: { select: { items: true } } },
    });

    if (!product) return { error: "Product not found." };

    const itemCount = product._count.items;

    await createAuditLog({
      shopId: shop.id,
      action: "product.delete_with_items.started",
      entity: "Product",
      entityId: product.id,
      metadata: {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category,
        deletedItemCount: itemCount,
      },
    });

    const deletedItemCount = await db.$transaction(async (tx) => {
      const deleteItemsResult = await tx.serializedItem.deleteMany({
        where: { productId: product.id, shopId: shop.id },
      });

      await tx.product.delete({
        where: { id: product.id },
      });

      return deleteItemsResult.count;
    });

    await createAuditLog({
      shopId: shop.id,
      action: "serialized_items.bulk_deleted_for_product",
      entity: "Product",
      entityId: product.id,
      metadata: {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category,
        deletedItemCount,
      },
    });

    await createAuditLog({
      shopId: shop.id,
      action: "product.deleted",
      entity: "Product",
      entityId: product.id,
      metadata: {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category,
        deletedItemCount,
      },
    });

    return {
      success: `Product "${product.sku}" and ${deletedItemCount} local list item(s) deleted from app database. This does not affect Shopify.`,
    };
  }

  if (intent === "createCategory") {
    const name = String(formData.get("name") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const active = formData.get("active") === "on";

    if (!name) return { error: "Category name is required." };

    const duplicate = await db.productCategory.findFirst({
      where: {
        shopId: shop.id,
        name: { equals: name, mode: "insensitive" },
      },
    });

    if (duplicate) {
      return {
        error: `A product category named "${name}" already exists.`,
      };
    }

    try {
      const category = await db.productCategory.create({
        data: {
          shopId: shop.id,
          name,
          notes: notes || null,
          active,
        },
      });

      await createAuditLog({
        shopId: shop.id,
        action: "product_category.created",
        entity: "ProductCategory",
        entityId: category.id,
        metadata: { name: category.name, notes: category.notes, active },
      });

      return { success: `Product category "${name}" created.` };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `A product category named "${name}" already exists.`,
        };
      }
      throw error;
    }
  }

  if (intent === "updateCategory") {
    const categoryId = String(formData.get("categoryId") ?? "");
    const name = String(formData.get("name") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const active = formData.get("active") === "on";

    if (!name) return { error: "Category name is required." };

    const category = await db.productCategory.findFirst({
      where: { id: categoryId, shopId: shop.id },
    });

    if (!category) return { error: "Product category not found." };

    const duplicate = await db.productCategory.findFirst({
      where: {
        shopId: shop.id,
        name: { equals: name, mode: "insensitive" },
        NOT: { id: category.id },
      },
    });

    if (duplicate) {
      return {
        error: `A product category named "${name}" already exists.`,
      };
    }

    const before = {
      name: category.name,
      notes: category.notes,
      active: category.active,
    };

    try {
      const updated = await db.productCategory.update({
        where: { id: category.id },
        data: {
          name,
          notes: notes || null,
          active,
        },
      });

      if (category.name !== updated.name) {
        await db.product.updateMany({
          where: { productCategoryId: category.id, shopId: shop.id },
          data: { category: updated.name },
        });
      }

      await createAuditLog({
        shopId: shop.id,
        action: "product_category.updated",
        entity: "ProductCategory",
        entityId: category.id,
        metadata: {
          before,
          after: {
            name: updated.name,
            notes: updated.notes,
            active: updated.active,
          },
        },
      });

      return { success: `Product category "${updated.name}" updated.` };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `A product category named "${name}" already exists.`,
        };
      }
      throw error;
    }
  }

  if (intent === "toggleCategory") {
    const categoryId = String(formData.get("categoryId") ?? "");

    const category = await db.productCategory.findFirst({
      where: { id: categoryId, shopId: shop.id },
    });

    if (!category) return { error: "Product category not found." };

    const nextActive = !category.active;

    await db.productCategory.update({
      where: { id: category.id },
      data: { active: nextActive },
    });

    await createAuditLog({
      shopId: shop.id,
      action: nextActive
        ? "product_category.activated"
        : "product_category.deactivated",
      entity: "ProductCategory",
      entityId: category.id,
      metadata: { name: category.name, active: nextActive },
    });

    return {
      success: `Product category "${category.name}" marked ${nextActive ? "active" : "inactive"}.`,
    };
  }

  if (intent === "deleteCategory") {
    const categoryId = String(formData.get("categoryId") ?? "");

    const category = await db.productCategory.findFirst({
      where: { id: categoryId, shopId: shop.id },
      include: { _count: { select: { products: true } } },
    });

    if (!category) return { error: "Product category not found." };

    if (category._count.products > 0) {
      return {
        error:
          "Cannot delete this product category because products are assigned. Deactivate it instead.",
      };
    }

    await createAuditLog({
      shopId: shop.id,
      action: "product_category.deleted",
      entity: "ProductCategory",
      entityId: category.id,
      metadata: { name: category.name, notes: category.notes },
    });

    await db.productCategory.delete({ where: { id: category.id } });

    return {
      success: `Product category "${category.name}" deleted.`,
    };
  }

  if (intent === "createColor") {
    const name = String(formData.get("name") ?? "").trim();
    const hex = String(formData.get("hex") ?? "").trim();
    const active = formData.get("active") === "on";

    if (!name) return { error: "Color name is required." };

    const duplicate = await db.color.findFirst({
      where: {
        shopId: shop.id,
        name: { equals: name, mode: "insensitive" },
      },
    });

    if (duplicate) {
      return {
        error: `A color named "${name}" already exists.`,
      };
    }

    try {
      const color = await db.color.create({
        data: {
          shopId: shop.id,
          name,
          hex: hex || null,
          active,
        },
      });

      await createAuditLog({
        shopId: shop.id,
        action: "color.created",
        entity: "Color",
        entityId: color.id,
        metadata: { name: color.name, hex: color.hex, active },
      });

      return { success: `Color "${name}" created.` };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `A color named "${name}" already exists.`,
        };
      }
      throw error;
    }
  }

  if (intent === "updateColor") {
    const colorId = String(formData.get("colorId") ?? "");
    const name = String(formData.get("name") ?? "").trim();
    const hex = String(formData.get("hex") ?? "").trim();
    const active = formData.get("active") === "on";

    if (!name) return { error: "Color name is required." };

    const color = await db.color.findFirst({
      where: { id: colorId, shopId: shop.id },
    });

    if (!color) return { error: "Color not found." };

    const duplicate = await db.color.findFirst({
      where: {
        shopId: shop.id,
        name: { equals: name, mode: "insensitive" },
        NOT: { id: color.id },
      },
    });

    if (duplicate) {
      return {
        error: `A color named "${name}" already exists.`,
      };
    }

    const before = {
      name: color.name,
      hex: color.hex,
      active: color.active,
    };

    try {
      const updated = await db.color.update({
        where: { id: color.id },
        data: {
          name,
          hex: hex || null,
          active,
        },
      });

      if (color.name !== updated.name) {
        await db.serializedItem.updateMany({
          where: { colorId: color.id, shopId: shop.id },
          data: { color: updated.name },
        });
      }

      await createAuditLog({
        shopId: shop.id,
        action: "color.updated",
        entity: "Color",
        entityId: color.id,
        metadata: {
          before,
          after: {
            name: updated.name,
            hex: updated.hex,
            active: updated.active,
          },
        },
      });

      return { success: `Color "${updated.name}" updated.` };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `A color named "${name}" already exists.`,
        };
      }
      throw error;
    }
  }

  if (intent === "toggleColor") {
    const colorId = String(formData.get("colorId") ?? "");

    const color = await db.color.findFirst({
      where: { id: colorId, shopId: shop.id },
    });

    if (!color) return { error: "Color not found." };

    const nextActive = !color.active;

    await db.color.update({
      where: { id: color.id },
      data: { active: nextActive },
    });

    await createAuditLog({
      shopId: shop.id,
      action: nextActive ? "color.activated" : "color.deactivated",
      entity: "Color",
      entityId: color.id,
      metadata: { name: color.name, active: nextActive },
    });

    return {
      success: `Color "${color.name}" marked ${nextActive ? "active" : "inactive"}.`,
    };
  }

  if (intent === "deleteColor") {
    const colorId = String(formData.get("colorId") ?? "");

    const color = await db.color.findFirst({
      where: { id: colorId, shopId: shop.id },
      include: { _count: { select: { items: true } } },
    });

    if (!color) return { error: "Color not found." };

    if (color._count.items > 0) {
      return {
        error:
          "Cannot delete this color because items are using it. Deactivate it instead.",
      };
    }

    await createAuditLog({
      shopId: shop.id,
      action: "color.deleted",
      entity: "Color",
      entityId: color.id,
      metadata: { name: color.name, hex: color.hex },
    });

    await db.color.delete({ where: { id: color.id } });

    return { success: `Color "${color.name}" deleted.` };
  }

  return { error: "Unknown action." };
};

export default function ProductsPage() {
  const { products, productCategories, colors } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [search, setSearch] = useState("");
  const [editingProductId, setEditingProductId] = useState<string | null>(
    null,
  );
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
    null,
  );
  const [editingColorId, setEditingColorId] = useState<string | null>(null);

  const categoryOptions = useMemo(
    () =>
      productCategories.filter(
        (category) =>
          category.active ||
          category.id ===
            products.find((product) => product.id === editingProductId)
              ?.productCategoryId,
      ),
    [productCategories, products, editingProductId],
  );

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((product) => {
      const activeLabel = product.active ? "active" : "inactive";
      const haystack = [
        product.name,
        product.productCategoryName,
        activeLabel,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        skuMatchesSearch(product.sku, q) || haystack.includes(q.toLowerCase())
      );
    });
  }, [products, search]);

  return (
    <s-page heading="Products">
      {actionData?.error && (
        <s-banner tone="critical" heading="Could not save">
          {actionData.error}
        </s-banner>
      )}
      {actionData?.success && (
        <s-banner tone="success" heading="Saved">
          {actionData.success}
        </s-banner>
      )}

      <s-section heading="About products">
        <s-text>
          Products are stored only in this app database. SKUs are saved in
          uppercase. Creating, editing, or deleting a product here does not
          create or change any Shopify product.
        </s-text>
      </s-section>

      <s-section heading="Add product">
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="sku"
              label="SKU"
              required
              autocomplete="off"
            />
            <s-text-field
              name="name"
              label="Name"
              required
              autocomplete="off"
            />
            <s-select name="productCategoryId" label="Category" value="">
              <s-option value="">No category</s-option>
              {categoryOptions.map((category) => (
                <s-option key={category.id} value={category.id}>
                  {category.name}
                </s-option>
              ))}
            </s-select>
            <s-text-area name="notes" label="Notes" />
            <s-checkbox name="active" label="Active" defaultChecked />
            <s-button type="submit" variant="primary">
              Create product
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`All products (${filteredProducts.length})`}>
        <s-text-field
          label="Search products"
          value={search}
          onInput={(e) => setSearch(e.currentTarget.value)}
          autocomplete="off"
        />

        {products.length === 0 ? (
          <s-text>
            No products yet. Add your first product using the form above.
          </s-text>
        ) : filteredProducts.length === 0 ? (
          <s-text>No products match your search.</s-text>
        ) : (
          <>
            {editingProductId && (() => {
              const editingProduct = products.find(
                (product) => product.id === editingProductId,
              );
              if (!editingProduct) return null;

              const editCategoryOptions = productCategories.filter(
                (category) =>
                  category.active ||
                  category.id === editingProduct.productCategoryId,
              );

              return (
                <s-section heading={`Edit ${editingProduct.sku}`}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="updateProduct" />
                    <input
                      type="hidden"
                      name="productId"
                      value={editingProduct.id}
                    />
                    <s-stack direction="block" gap="base">
                      <s-text-field
                        name="sku"
                        label="SKU"
                        defaultValue={editingProduct.sku}
                        required
                        autocomplete="off"
                      />
                      <s-text-field
                        name="name"
                        label="Name"
                        defaultValue={editingProduct.name}
                        required
                        autocomplete="off"
                      />
                      <s-select
                        name="productCategoryId"
                        label="Category"
                        value={editingProduct.productCategoryId ?? ""}
                      >
                        <s-option value="">No category</s-option>
                        {editCategoryOptions.map((category) => (
                          <s-option key={category.id} value={category.id}>
                            {category.name}
                          </s-option>
                        ))}
                      </s-select>
                      <s-text-area
                        name="notes"
                        label="Notes"
                        defaultValue={editingProduct.notes ?? ""}
                      />
                      <s-checkbox
                        name="active"
                        label="Active"
                        defaultChecked={editingProduct.active}
                      />
                      <s-stack direction="inline" gap="base">
                        <s-button type="submit" variant="primary">
                          Save
                        </s-button>
                        <s-button
                          type="button"
                          variant="secondary"
                          onClick={() => setEditingProductId(null)}
                        >
                          Cancel
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </Form>
                </s-section>
              );
            })()}

            <s-table>
              <s-table-header-row>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Name</s-table-header>
                <s-table-header>Category</s-table-header>
                <s-table-header>Active</s-table-header>
                <s-table-header>In Stock</s-table-header>
                <s-table-header>Updated</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {filteredProducts.map((product) => (
                  <s-table-row key={product.id}>
                    <s-table-cell>{product.sku}</s-table-cell>
                    <s-table-cell>{product.name}</s-table-cell>
                    <s-table-cell>
                      {product.productCategoryName ?? "—"}
                    </s-table-cell>
                    <s-table-cell>{product.active ? "Yes" : "No"}</s-table-cell>
                    <s-table-cell>{product.inStockCount}</s-table-cell>
                    <s-table-cell>
                      {format(new Date(product.updatedAt), "MMM d, yyyy HH:mm")}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="base">
                        <s-button
                          type="button"
                          variant="secondary"
                          onClick={() => setEditingProductId(product.id)}
                        >
                          Edit
                        </s-button>
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="toggleActive"
                          />
                          <input
                            type="hidden"
                            name="productId"
                            value={product.id}
                          />
                          <s-button type="submit" variant="secondary">
                            {product.active ? "Deactivate" : "Activate"}
                          </s-button>
                        </Form>
                        {product.itemCount === 0 ? (
                          <Form
                            method="post"
                            onSubmit={(e) => {
                              if (
                                !confirm(
                                  "Delete this product from the app database? This does not affect Shopify.",
                                )
                              ) {
                                e.preventDefault();
                              }
                            }}
                          >
                            <input
                              type="hidden"
                              name="intent"
                              value="deleteProduct"
                            />
                            <input
                              type="hidden"
                              name="productId"
                              value={product.id}
                            />
                            <s-button type="submit" variant="secondary">
                              Delete
                            </s-button>
                          </Form>
                        ) : (
                          <Form
                            method="post"
                            onSubmit={(e) => {
                              if (
                                !confirm(
                                  "This will delete the local product and all local list items attached to it. This does not affect Shopify.",
                                )
                              ) {
                                e.preventDefault();
                              }
                            }}
                          >
                            <input
                              type="hidden"
                              name="intent"
                              value="deleteProductWithItems"
                            />
                            <input
                              type="hidden"
                              name="productId"
                              value={product.id}
                            />
                            <s-button type="submit" variant="secondary">
                              Delete product + local list items
                            </s-button>
                          </Form>
                        )}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </>
        )}
      </s-section>

      <s-section heading="Product Categories">
        <s-section heading="Add product category">
          <Form method="post">
            <input type="hidden" name="intent" value="createCategory" />
            <s-stack direction="block" gap="base">
              <s-text-field
                name="name"
                label="Name"
                required
                autocomplete="off"
              />
              <s-text-area name="notes" label="Notes" />
              <s-checkbox name="active" label="Active" defaultChecked />
              <s-button type="submit" variant="primary">
                Create category
              </s-button>
            </s-stack>
          </Form>
        </s-section>

        {editingCategoryId && (() => {
          const editingCategory = productCategories.find(
            (category) => category.id === editingCategoryId,
          );
          if (!editingCategory) return null;

          return (
            <s-section heading={`Edit category ${editingCategory.name}`}>
              <Form method="post">
                <input type="hidden" name="intent" value="updateCategory" />
                <input
                  type="hidden"
                  name="categoryId"
                  value={editingCategory.id}
                />
                <s-stack direction="block" gap="base">
                  <s-text-field
                    name="name"
                    label="Name"
                    defaultValue={editingCategory.name}
                    required
                    autocomplete="off"
                  />
                  <s-text-area
                    name="notes"
                    label="Notes"
                    defaultValue={editingCategory.notes ?? ""}
                  />
                  <s-checkbox
                    name="active"
                    label="Active"
                    defaultChecked={editingCategory.active}
                  />
                  <s-stack direction="inline" gap="base">
                    <s-button type="submit" variant="primary">
                      Save
                    </s-button>
                    <s-button
                      type="button"
                      variant="secondary"
                      onClick={() => setEditingCategoryId(null)}
                    >
                      Cancel
                    </s-button>
                  </s-stack>
                </s-stack>
              </Form>
            </s-section>
          );
        })()}

        {productCategories.length === 0 ? (
          <s-text>No product categories yet.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Notes</s-table-header>
              <s-table-header>Active</s-table-header>
              <s-table-header>Products</s-table-header>
              <s-table-header>Assigned SKUs</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {productCategories.map((category) => (
                <s-table-row key={category.id}>
                  <s-table-cell>{category.name}</s-table-cell>
                  <s-table-cell>{category.notes ?? "—"}</s-table-cell>
                  <s-table-cell>{category.active ? "Yes" : "No"}</s-table-cell>
                  <s-table-cell>{category.productCount}</s-table-cell>
                  <s-table-cell>
                    {category.assignedSkus || "—"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base">
                      <s-button
                        type="button"
                        variant="secondary"
                        onClick={() => setEditingCategoryId(category.id)}
                      >
                        Edit
                      </s-button>
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="toggleCategory"
                        />
                        <input
                          type="hidden"
                          name="categoryId"
                          value={category.id}
                        />
                        <s-button type="submit" variant="secondary">
                          {category.active ? "Deactivate" : "Activate"}
                        </s-button>
                      </Form>
                      <Form
                        method="post"
                        onSubmit={(e) => {
                          if (
                            !confirm(
                              `Delete product category "${category.name}"?`,
                            )
                          ) {
                            e.preventDefault();
                          }
                        }}
                      >
                        <input
                          type="hidden"
                          name="intent"
                          value="deleteCategory"
                        />
                        <input
                          type="hidden"
                          name="categoryId"
                          value={category.id}
                        />
                        <s-button type="submit" variant="secondary">
                          Delete
                        </s-button>
                      </Form>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Colors">
        <s-section heading="Add color">
          <Form method="post">
            <input type="hidden" name="intent" value="createColor" />
            <s-stack direction="block" gap="base">
              <s-text-field
                name="name"
                label="Name"
                required
                autocomplete="off"
              />
              <s-text-field
                name="hex"
                label="Hex"
                autocomplete="off"
                placeholder="#000000"
              />
              <s-checkbox name="active" label="Active" defaultChecked />
              <s-button type="submit" variant="primary">
                Create color
              </s-button>
            </s-stack>
          </Form>
        </s-section>

        {editingColorId && (() => {
          const editingColor = colors.find(
            (color) => color.id === editingColorId,
          );
          if (!editingColor) return null;

          return (
            <s-section heading={`Edit color ${editingColor.name}`}>
              <Form method="post">
                <input type="hidden" name="intent" value="updateColor" />
                <input type="hidden" name="colorId" value={editingColor.id} />
                <s-stack direction="block" gap="base">
                  <s-text-field
                    name="name"
                    label="Name"
                    defaultValue={editingColor.name}
                    required
                    autocomplete="off"
                  />
                  <s-text-field
                    name="hex"
                    label="Hex"
                    defaultValue={editingColor.hex ?? ""}
                    autocomplete="off"
                    placeholder="#000000"
                  />
                  <s-checkbox
                    name="active"
                    label="Active"
                    defaultChecked={editingColor.active}
                  />
                  <s-stack direction="inline" gap="base">
                    <s-button type="submit" variant="primary">
                      Save
                    </s-button>
                    <s-button
                      type="button"
                      variant="secondary"
                      onClick={() => setEditingColorId(null)}
                    >
                      Cancel
                    </s-button>
                  </s-stack>
                </s-stack>
              </Form>
            </s-section>
          );
        })()}

        {colors.length === 0 ? (
          <s-text>No colors yet.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Hex</s-table-header>
              <s-table-header>Active</s-table-header>
              <s-table-header>Items</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {colors.map((color) => (
                <s-table-row key={color.id}>
                  <s-table-cell>{color.name}</s-table-cell>
                  <s-table-cell>{color.hex ?? "—"}</s-table-cell>
                  <s-table-cell>{color.active ? "Yes" : "No"}</s-table-cell>
                  <s-table-cell>{color.itemCount}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base">
                      <s-button
                        type="button"
                        variant="secondary"
                        onClick={() => setEditingColorId(color.id)}
                      >
                        Edit
                      </s-button>
                      <Form method="post">
                        <input type="hidden" name="intent" value="toggleColor" />
                        <input type="hidden" name="colorId" value={color.id} />
                        <s-button type="submit" variant="secondary">
                          {color.active ? "Deactivate" : "Activate"}
                        </s-button>
                      </Form>
                      <Form
                        method="post"
                        onSubmit={(e) => {
                          if (!confirm(`Delete color "${color.name}"?`)) {
                            e.preventDefault();
                          }
                        }}
                      >
                        <input
                          type="hidden"
                          name="intent"
                          value="deleteColor"
                        />
                        <input type="hidden" name="colorId" value={color.id} />
                        <s-button type="submit" variant="secondary">
                          Delete
                        </s-button>
                      </Form>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
