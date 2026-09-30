-- CreateTable
CREATE TABLE "HygieneCertificate" (
    "id" TEXT NOT NULL,
    "freelancerId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "dataEnc" BYTEA NOT NULL,
    "issuedOn" DATE NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HygieneCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HygieneCertificate_freelancerId_key" ON "HygieneCertificate"("freelancerId");

-- AddForeignKey
ALTER TABLE "HygieneCertificate" ADD CONSTRAINT "HygieneCertificate_freelancerId_fkey" FOREIGN KEY ("freelancerId") REFERENCES "Freelancer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

