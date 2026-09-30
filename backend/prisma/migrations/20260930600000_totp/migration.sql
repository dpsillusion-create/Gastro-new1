-- DropIndex
DROP INDEX "User_phone_key";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN     "totpFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totpLastStep" INTEGER,
ADD COLUMN     "totpLockedUntil" TIMESTAMP(3),
ADD COLUMN     "totpSecretEnc" TEXT;

