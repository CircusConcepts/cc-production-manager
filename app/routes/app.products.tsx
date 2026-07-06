import { Prisma } from "@prisma/client";
import { format } from "date-fns";
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
    },
  });

  return {
    products: products.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category,
      active: product.active,
      inStockCount: product.items.length,
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
        metadata: { sku, name },
      });

      return { success: `Product "${sku}" created.` };
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
      success: `Product "${product.sku}" marked as ${product.active ? "inactive" : "active"}.`,
    };
  }

  return { error: "Unknown action." };
};

export default function ProductsPage() {
  const { products } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Products">
      {actionData?.error && (
        <s-banner tone="critical" heading="Error">
          {actionData.error}
        </s-banner>
      )}
      {actionData?.success && (
        <s-banner tone="success" heading="Success">
          {actionData.success}
        </s-banner>
      )}

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

      <s-section heading={`${products.length} products`}>
        {products.length === 0 ? (
          <s-text>No products yet. Create one using the form above.</s-text>
        ) : (
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
              {products.map((product) => (
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
                    <Form method="post">
                      <input type="hidden" name="intent" value="toggleActive" />
                      <input type="hidden" name="productId" value={product.id} />
                      <s-button type="submit" variant="secondary">
                        {product.active ? "Deactivate" : "Activate"}
                      </s-button>
                    </Form>
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
