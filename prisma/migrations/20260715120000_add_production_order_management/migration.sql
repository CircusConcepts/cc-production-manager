-- AlterTable: extend ProductionOrder with customer, dates, employee fields
ALTER TABLE "ProductionOrder" ADD COLUMN "customerName" TEXT;
ALTER TABLE "ProductionOrder" ADD COLUMN "customerAddress" TEXT;
ALTER TABLE "ProductionOrder" ADD COLUMN "orderNote" TEXT;
ALTER TABLE "ProductionOrder" ADD COLUMN "orderDate" DATE;
ALTER TABLE "ProductionOrder" ADD COLUMN "dueDate" DATE;
ALTER TABLE "ProductionOrder" ADD COLUMN "employee" TEXT;

-- Backfill orderDate from createdAt for existing rows
UPDATE "ProductionOrder" SET "orderDate" = ("createdAt" AT TIME ZONE 'UTC')::date WHERE "orderDate" IS NULL;

-- Make orderDate required with a safe default for new rows
ALTER TABLE "ProductionOrder" ALTER COLUMN "orderDate" SET DEFAULT CURRENT_DATE;
ALTER TABLE "ProductionOrder" ALTER COLUMN "orderDate" SET NOT NULL;

-- AlterTable: extend ProductionOrderLine with color and size snapshots
ALTER TABLE "ProductionOrderLine" ADD COLUMN "colorId" TEXT;
ALTER TABLE "ProductionOrderLine" ADD COLUMN "colorName" TEXT;
ALTER TABLE "ProductionOrderLine" ADD COLUMN "size" TEXT;

-- CreateTable: ProductionOrderDocument
CREATE TABLE "ProductionOrderDocument" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionOrderDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionOrder_shopId_orderDate_idx" ON "ProductionOrder"("shopId", "orderDate");
CREATE INDEX "ProductionOrder_shopId_dueDate_idx" ON "ProductionOrder"("shopId", "dueDate");
CREATE INDEX "ProductionOrder_shopId_customerName_idx" ON "ProductionOrder"("shopId", "customerName");
CREATE INDEX "ProductionOrderLine_shopId_productionOrderId_idx" ON "ProductionOrderLine"("shopId", "productionOrderId");
CREATE INDEX "ProductionOrderDocument_shopId_productionOrderId_idx" ON "ProductionOrderDocument"("shopId", "productionOrderId");
CREATE UNIQUE INDEX "ProductionOrderDocument_shopId_storageKey_key" ON "ProductionOrderDocument"("shopId", "storageKey");

-- AddForeignKey
ALTER TABLE "ProductionOrderLine" ADD CONSTRAINT "ProductionOrderLine_colorId_fkey" FOREIGN KEY ("colorId") REFERENCES "Color"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProductionOrderDocument" ADD CONSTRAINT "ProductionOrderDocument_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductionOrderDocument" ADD CONSTRAINT "ProductionOrderDocument_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "ProductionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
