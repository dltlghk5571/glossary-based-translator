-- CreateTable
CREATE TABLE "Glossary" (
    "id" SERIAL NOT NULL,
    "korean" TEXT NOT NULL,
    "english" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Glossary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Translation" (
    "id" SERIAL NOT NULL,
    "sourceText" TEXT NOT NULL,
    "translatedText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Translation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranslationHistory" (
    "id" SERIAL NOT NULL,
    "translationId" INTEGER NOT NULL,
    "beforeText" TEXT,
    "afterText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranslationHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Glossary_korean_idx" ON "Glossary"("korean");

-- CreateIndex
CREATE INDEX "Glossary_english_idx" ON "Glossary"("english");

-- CreateIndex
CREATE INDEX "TranslationHistory_translationId_idx" ON "TranslationHistory"("translationId");

-- AddForeignKey
ALTER TABLE "TranslationHistory" ADD CONSTRAINT "TranslationHistory_translationId_fkey" FOREIGN KEY ("translationId") REFERENCES "Translation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
