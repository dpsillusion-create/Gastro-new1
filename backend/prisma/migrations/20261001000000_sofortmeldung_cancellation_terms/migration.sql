-- CreateEnum
CREATE TYPE "CancelledBy" AS ENUM ('FREELANCER', 'RESTAURANT');

-- AlterEnum
ALTER TYPE "ApplicationStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT;

-- AlterTable
ALTER TABLE "Freelancer" ADD COLUMN     "lateCancelCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ImmediateNotification" ADD COLUMN     "reference" TEXT,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3),
ADD COLUMN     "reportedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ShiftCancellation" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "freelancerId" TEXT NOT NULL,
    "cancelledBy" "CancelledBy" NOT NULL,
    "hoursBeforeStart" DOUBLE PRECISION NOT NULL,
    "late" BOOLEAN NOT NULL,
    "reason" TEXT,
    "sofortmeldungReported" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftCancellation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftCancellation_shiftId_idx" ON "ShiftCancellation"("shiftId");

-- CreateIndex
CREATE INDEX "ShiftCancellation_freelancerId_createdAt_idx" ON "ShiftCancellation"("freelancerId", "createdAt");

