
CREATE TABLE "public"."review_organization_level"("organization_value" text NOT NULL, "level" integer NOT NULL, PRIMARY KEY ("organization_value") , FOREIGN KEY ("organization_value") REFERENCES "public"."review_organization"("value") ON UPDATE no action ON DELETE no action, UNIQUE ("organization_value"));