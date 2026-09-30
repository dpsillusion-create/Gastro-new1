-- CreateEnum
CREATE TYPE "Skill" AS ENUM ('BAR', 'SERVICE', 'KITCHEN', 'DISHWASHING');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'MATCHED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'MANAGER', 'STAFF');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('NEEDS_DATA', 'READY', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Restaurant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "employerBetriebsnummer" TEXT,

    CONSTRAINT "Restaurant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantMember" (
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,

    CONSTRAINT "RestaurantMember_pkey" PRIMARY KEY ("userId","restaurantId")
);

-- CreateTable
CREATE TABLE "MarketplaceShift" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "requiredSkill" "Skill" NOT NULL,
    "requirements" TEXT,
    "activityKey" TEXT,
    "hourlyRateCents" INTEGER NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Freelancer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "verifiedSkills" "Skill"[],
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "homeLatitude" DOUBLE PRECISION,
    "homeLongitude" DOUBLE PRECISION,
    "social_security_number" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "birth_date" DATE NOT NULL,
    "complianceValidatedAt" TIMESTAMP(3),
    "reliability_score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendedUntil" TIMESTAMP(3),
    "noShowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Freelancer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftApplication" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "freelancerId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ShiftApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemporaryEmployee" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "freelancerId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "clockInPinHash" TEXT,
    "clockedInAt" TIMESTAMP(3),
    "noShowRecordedAt" TIMESTAMP(3),

    CONSTRAINT "TemporaryEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RosterEntry" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "temporaryEmployeeId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "hourlyRateCents" INTEGER NOT NULL,

    CONSTRAINT "RosterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImmediateNotification" (
    "id" TEXT NOT NULL,
    "temporaryEmployeeId" TEXT NOT NULL,
    "payloadEnc" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'READY',
    "missingFields" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImmediateNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "RestaurantMember_restaurantId_idx" ON "RestaurantMember"("restaurantId");

-- CreateIndex
CREATE INDEX "MarketplaceShift_status_latitude_longitude_idx" ON "MarketplaceShift"("status", "latitude", "longitude");

-- CreateIndex
CREATE INDEX "MarketplaceShift_restaurantId_status_idx" ON "MarketplaceShift"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "MarketplaceShift_startTime_idx" ON "MarketplaceShift"("startTime");

-- CreateIndex
CREATE UNIQUE INDEX "Freelancer_userId_key" ON "Freelancer"("userId");

-- CreateIndex
CREATE INDEX "ShiftApplication_freelancerId_status_idx" ON "ShiftApplication"("freelancerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftApplication_shiftId_freelancerId_key" ON "ShiftApplication"("shiftId", "freelancerId");

-- CreateIndex
CREATE UNIQUE INDEX "TemporaryEmployee_shiftId_key" ON "TemporaryEmployee"("shiftId");

-- CreateIndex
CREATE INDEX "TemporaryEmployee_restaurantId_validFrom_idx" ON "TemporaryEmployee"("restaurantId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "RosterEntry_temporaryEmployeeId_key" ON "RosterEntry"("temporaryEmployeeId");

-- CreateIndex
CREATE INDEX "RosterEntry_restaurantId_startTime_idx" ON "RosterEntry"("restaurantId", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX "ImmediateNotification_temporaryEmployeeId_key" ON "ImmediateNotification"("temporaryEmployeeId");

-- CreateIndex
CREATE INDEX "WebhookEvent_deliveredAt_createdAt_idx" ON "WebhookEvent"("deliveredAt", "createdAt");

-- AddForeignKey
ALTER TABLE "RestaurantMember" ADD CONSTRAINT "RestaurantMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantMember" ADD CONSTRAINT "RestaurantMember_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceShift" ADD CONSTRAINT "MarketplaceShift_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Freelancer" ADD CONSTRAINT "Freelancer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftApplication" ADD CONSTRAINT "ShiftApplication_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "MarketplaceShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftApplication" ADD CONSTRAINT "ShiftApplication_freelancerId_fkey" FOREIGN KEY ("freelancerId") REFERENCES "Freelancer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemporaryEmployee" ADD CONSTRAINT "TemporaryEmployee_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemporaryEmployee" ADD CONSTRAINT "TemporaryEmployee_freelancerId_fkey" FOREIGN KEY ("freelancerId") REFERENCES "Freelancer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemporaryEmployee" ADD CONSTRAINT "TemporaryEmployee_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "MarketplaceShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterEntry" ADD CONSTRAINT "RosterEntry_temporaryEmployeeId_fkey" FOREIGN KEY ("temporaryEmployeeId") REFERENCES "TemporaryEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImmediateNotification" ADD CONSTRAINT "ImmediateNotification_temporaryEmployeeId_fkey" FOREIGN KEY ("temporaryEmployeeId") REFERENCES "TemporaryEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

