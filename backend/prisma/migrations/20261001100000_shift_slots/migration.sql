-- AlterTable
ALTER TABLE "MarketplaceShift" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "slotCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "slotIndex" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "MarketplaceShift_groupId_idx" ON "MarketplaceShift"("groupId");

