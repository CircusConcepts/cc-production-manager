import type { ItemSourceType, ItemStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { format } from "date-fns";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import db from "../db.server";
import { createAuditLog } from "../services/audit.server";
import { getOrCreateShop } from "../services/shop.server";
import { authenticate } from "../shopify.server";

const ITEM_STATUSES: ItemStatus[] = [
  "PLANNED",
  "IN_PRODUCTION",
  "CUTTING",
  "SEWING",
  "ASSEMBLY",
  "QC",
  "READY",
  "IN_STOCK",
  "RESERVED",
  "SHIPPED",
  "SCRAPPED",
];

const SOURCE_TYPES: ItemSourceType[] = ["STOCK", "MANUAL", "IMPORT"];

function isItemStatus(value: string): value is ItemStatus {
  return ITEM_STATUSES.includes(value as ItemStatus);
}

function isSourceType(value: string): value is ItemSourceType {
  return SOURCE_TYPES.includes(value as ItemSourceType);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);

  const [items, products] = await Promise.all([
    db.serializedItem.findMany({
      where: { shopId: shop.id },
      orderBy: { updatedAt: "desc" },
      include: {
        product: { select: { sku: true, name: true } },
      },
    }),
    db.product.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: { sku: "asc" },
      select: { sku: true, name: true },
    }),
  ]);

  return {
    items: items.map((item) => ({
      id: item.id,
      serialNumber: item.serialNumber,
      sku: item.product.sku,
      productName: item.product.name,
      status: item.status,
      sourceType: item.sourceType,
      orderNumber: item.orderNumber,
      notes: item.notes,
      updatedAt: item.updatedAt.toISOString(),
    })),
    products,
    statuses: ITEM_STATUSES,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create") {
    const productSku = String(formData.get("productSku") ?? "").trim();
    const serialNumber = String(formData.get("serialNumber") ?? "").trim();
    const status = String(formData.get("status") ?? "IN_STOCK");
    const sourceType = String(formData.get("sourceType") ?? "STOCK");
    const orderNumber = String(formData.get("orderNumber") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();

    if (!productSku) return { error: "Product SKU is required." };
    if (!serialNumber) return { error: "Serial number is required." };
    if (!isItemStatus(status)) return { error: "Invalid status." };
    if (!isSourceType(sourceType)) return { error: "Invalid source type." };

    const product = await db.product.findFirst({
      where: { shopId: shop.id, sku: productSku },
    });

    if (!product) {
      return { error: `Product SKU "${productSku}" not found.` };
    }

    try {
      const item = await db.serializedItem.create({
        data: {
          shopId: shop.id,
          productId: product.id,
          serialNumber,
          status,
          sourceType,
          orderNumber: orderNumber || null,
          notes: notes || null,
        },
      });

      await createAuditLog({
        shopId: shop.id,
        action: "serialized_item.created",
        entity: "SerializedItem",
        entityId: item.id,
        metadata: {
          serialNumber,
          sku: productSku,
          status,
          sourceType,
        },
      });

      return { success: `Item "${serialNumber}" created.` };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          error: `Serial number "${serialNumber}" already exists for this shop.`,
        };
      }
      throw error;
    }
  }

  if (intent === "updateStatus") {
    const itemId = String(formData.get("itemId") ?? "");
    const status = String(formData.get("status") ?? "");

    if (!isItemStatus(status)) {
      return { error: "Invalid status." };
    }

    const item = await db.serializedItem.findFirst({
      where: { id: itemId, shopId: shop.id },
      include: { product: { select: { sku: true } } },
    });

    if (!item) {
      return { error: "Item not found." };
    }

    if (item.status === status) {
      return { success: `Item "${item.serialNumber}" is already ${status}.` };
    }

    const previousStatus = item.status;

    await db.serializedItem.update({
      where: { id: item.id },
      data: { status },
    });

    await createAuditLog({
      shopId: shop.id,
      action: "item.status_updated",
      entity: "SerializedItem",
      entityId: item.id,
      metadata: {
        serialNumber: item.serialNumber,
        sku: item.product.sku,
        from: previousStatus,
        to: status,
      },
    });

    return {
      success: `Item "${item.serialNumber}" updated to ${status}.`,
    };
  }

  return { error: "Unknown action." };
};

export default function SerializedItemsPage() {
  const { items, products, statuses } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Serialized Items">
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

      <s-section heading="Add serialized item">
        {products.length === 0 ? (
          <s-text>Create a product first before adding serialized items.</s-text>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="create" />
            <s-stack direction="block" gap="base">
              <s-select name="productSku" label="Product SKU" required>
                <s-option value="">Select a product</s-option>
                {products.map((product) => (
                  <s-option key={product.sku} value={product.sku}>
                    {product.sku} — {product.name}
                  </s-option>
                ))}
              </s-select>
              <s-text-field
                name="serialNumber"
                label="Serial number"
                required
                autocomplete="off"
              />
              <s-select name="status" label="Status" value="IN_STOCK">
                {statuses.map((status) => (
                  <s-option key={status} value={status}>
                    {status}
                  </s-option>
                ))}
              </s-select>
              <s-select name="sourceType" label="Source type" value="STOCK">
                {SOURCE_TYPES.map((sourceType) => (
                  <s-option key={sourceType} value={sourceType}>
                    {sourceType}
                  </s-option>
                ))}
              </s-select>
              <s-text-field
                name="orderNumber"
                label="Order number"
                autocomplete="off"
              />
              <s-text-area name="notes" label="Notes" />
              <s-button type="submit" variant="primary">
                Create item
              </s-button>
            </s-stack>
          </Form>
        )}
      </s-section>

      <s-section heading={`${items.length} items`}>
        {items.length === 0 ? (
          <s-text>No serialized items yet.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Serial Number</s-table-header>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Source</s-table-header>
              <s-table-header>Order #</s-table-header>
              <s-table-header>Notes</s-table-header>
              <s-table-header>Updated</s-table-header>
              <s-table-header>Update Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {items.map((item) => (
                <s-table-row key={item.id}>
                  <s-table-cell>{item.serialNumber}</s-table-cell>
                  <s-table-cell>{item.sku}</s-table-cell>
                  <s-table-cell>{item.productName}</s-table-cell>
                  <s-table-cell>{item.status}</s-table-cell>
                  <s-table-cell>{item.sourceType}</s-table-cell>
                  <s-table-cell>{item.orderNumber ?? "—"}</s-table-cell>
                  <s-table-cell>{item.notes ?? "—"}</s-table-cell>
                  <s-table-cell>
                    {format(new Date(item.updatedAt), "MMM d, yyyy HH:mm")}
                  </s-table-cell>
                  <s-table-cell>
                    <Form method="post">
                      <input type="hidden" name="intent" value="updateStatus" />
                      <input type="hidden" name="itemId" value={item.id} />
                      <s-stack direction="inline" gap="base">
                        <s-select
                          name="status"
                          label="Status"
                          labelAccessibilityVisibility="exclusive"
                          value={item.status}
                        >
                          {statuses.map((status) => (
                            <s-option key={status} value={status}>
                              {status}
                            </s-option>
                          ))}
                        </s-select>
                        <s-button type="submit" variant="secondary">
                          Update
                        </s-button>
                      </s-stack>
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
