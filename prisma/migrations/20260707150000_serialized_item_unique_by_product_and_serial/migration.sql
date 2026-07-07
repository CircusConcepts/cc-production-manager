-- DropIndex
DROP INDEX IF EXISTS "SerializedItem_shopId_serialNumber_key";

-- CreateIndex
CREATE UNIQUE INDEX "SerializedItem_productId_serialNumber_key" ON "SerializedItem"("productId", "serialNumber");
