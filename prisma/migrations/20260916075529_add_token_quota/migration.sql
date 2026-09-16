-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bonusTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "monthlyTokenLimit" INTEGER NOT NULL DEFAULT 100000,
ADD COLUMN     "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "tokensUsedThisPeriod" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TokenTopUpRequest" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "grantedTokens" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "TokenTopUpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenTopUpRequest_userId_idx" ON "TokenTopUpRequest"("userId");

-- CreateIndex
CREATE INDEX "TokenTopUpRequest_status_idx" ON "TokenTopUpRequest"("status");

-- AddForeignKey
ALTER TABLE "TokenTopUpRequest" ADD CONSTRAINT "TokenTopUpRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
