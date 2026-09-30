ALTER TABLE "Freelancer" ADD COLUMN "claimedSkills" "Skill"[] DEFAULT ARRAY[]::"Skill"[],
ADD COLUMN "privacyConsentAt" TIMESTAMP(3);
