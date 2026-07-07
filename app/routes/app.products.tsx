import { Prisma } from "@prisma/client";
import { format } from "date-fns";
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import db from "../db.server";
import { createAuditLog } from "../services/audit.server";
import { getOrCreateShop } from "../services/shop.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const products = await db.product.findMany({
    where: { shopId: shop.id },
    orderBy: { name: "asc" },
    include: {
      items: {
        where: { status: "IN_STOCK" },
        select: { id: true },
      },
      _count: { select: { items: true } },
    },
  });

  return {
    products: products.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category,
      notes: product.notes,
      active: product.active,
      inStockCount: product.items.length,
      itemCount: product._count.items,
      updatedAt: product.updatedAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    const sku = String(formData.get("sku") ?? "").trim();
    const name = String(formData.get("name") ?? "").trim();
    const category = String(formData.get("category") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const active = formData.get("active") === "on";

    if (!sku) return { error: "SKU is required." };
    if (!name) return { error: "Name is required." };

    try {
      const product = await db.product.create({
        data: {
          shopId: shop.id,
          sku,
          name,
          category: category || null,
          notes: notes || null,
          active,
        },
      });

      await createAuditLog({
        shopId: shop.id,
        action: "product.created",
        entity: "Product",
        entityId: product.id,
        metadata: { sku, name, category: category || null },
      });

      return { success: `Product "${sku}" created. This does not affect Shopify.` };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `SKU "${sku}" already exists for this shop.`,
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
    const sku = String(formData.get("sku") ?? "").trim();
    const name = String(formData.get("name") ?? "").trim();
    const category = String(formData.get("category") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const active = formData.get("active") === "on";

    if (!sku) return { error: "SKU is required." };
    if (!name) return { error: "Name is required." };

    const product = await db.product.findFirst({
      where: { id: productId, shopId: shop.id },
    });

    if (!product) return { error: "Product not found." };

    const before = {
      sku: product.sku,
      name: product.name,
      category: product.category,
      notes: product.notes,
      active: product.active,
    };

    try {
      await db.product.update({
        where: { id: product.id },
        data: {
          sku,
          name,
          category: category || null,
          notes: notes || null,
          active,
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
            sku,
            name,
            category: category || null,
            notes: notes || null,
            active,
          },
        },
      });

      return { success: `Product "${sku}" updated. This does not affect Shopify.` };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `SKU "${sku}" already exists for this shop.`,
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
          "Cannot delete this product because it has list items. Use \"Delete product + local list items\" instead.",
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

  return { error: "Unknown action." };
};

export default function ProductsPage() {
  const { products } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [search, setSearch] = useState("");
  const [editingProductId, setEditingProductId] = useState<string | null>(null);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((product) => {
      const activeLabel = product.active ? "active" : "inactive";
      const haystack = [
        product.sku,
        product.name,
        product.category,
        activeLabel,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
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
          Products are stored only in this app database. Creating, editing, or
          deleting a product here does not create or change any Shopify product.
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
            <s-text-field
              name="category"
              label="Category"
              autocomplete="off"
            />
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

              return (
                <s-section heading={`Edit ${editingProduct.sku}`}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="updateProduct" />
                    <input type="hidden" name="productId" value={editingProduct.id} />
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
                      <s-text-field
                        name="category"
                        label="Category"
                        defaultValue={editingProduct.category ?? ""}
                        autocomplete="off"
                      />
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
                    <s-table-cell>{product.category ?? "—"}</s-table-cell>
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
                          <input type="hidden" name="intent" value="toggleActive" />
                          <input type="hidden" name="productId" value={product.id} />
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
                            <input type="hidden" name="intent" value="deleteProduct" />
                            <input type="hidden" name="productId" value={product.id} />
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
                            <input type="hidden" name="productId" value={product.id} />
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
    </s-page>
  );
}
