import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import {
  buildContentDisposition,
  isInlineViewableMimeType,
  readOrderDocument,
} from "../services/orderDocumentStorage.server";
import { getOrCreateShop } from "../services/shop.server";
import { sanitizeDisplayFilename } from "../utils/productionOrder";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getOrCreateShop(session.shop);
  const orderId = params.orderId;
  const documentId = params.documentId;

  if (!orderId || !documentId) {
    throw new Response("Not found", { status: 404 });
  }

  const document = await db.productionOrderDocument.findFirst({
    where: {
      id: documentId,
      shopId: shop.id,
      productionOrderId: orderId,
    },
  });

  if (!document) {
    throw new Response("Not found", { status: 404 });
  }

  let fileBuffer: Buffer;
  try {
    fileBuffer = await readOrderDocument(document.storageKey);
  } catch {
    throw new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const forceDownload = url.searchParams.get("download") === "1";
  const inline =
    !forceDownload && isInlineViewableMimeType(document.mimeType);
  const safeName = sanitizeDisplayFilename(document.originalName);

  return new Response(new Uint8Array(fileBuffer), {
    status: 200,
    headers: {
      "Content-Type": document.mimeType,
      "Content-Disposition": buildContentDisposition(safeName, inline),
      "Content-Length": String(fileBuffer.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
};
