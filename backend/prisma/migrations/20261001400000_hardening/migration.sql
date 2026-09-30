-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "passwordLockedUntil" TIMESTAMP(3),
ADD COLUMN     "sessionsValidFrom" TIMESTAMP(3);

