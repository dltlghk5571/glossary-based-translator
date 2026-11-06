-- CreateTable
CREATE TABLE "GlossarySuggestion" (
    "id" SERIAL NOT NULL,
    "korean" TEXT NOT NULL,
    "english" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'General',
    "aliases" TEXT NOT NULL DEFAULT '',
    "usageNote" TEXT NOT NULL DEFAULT '',
    "lastContext" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "userId" INTEGER NOT NULL,
    "reviewedById" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlossarySuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GlossarySuggestion_status_idx" ON "GlossarySuggestion"("status");

-- CreateIndex
CREATE INDEX "GlossarySuggestion_korean_idx" ON "GlossarySuggestion"("korean");

-- AddForeignKey
ALTER TABLE "GlossarySuggestion" ADD CONSTRAINT "GlossarySuggestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

