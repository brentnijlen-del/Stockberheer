# Installatie gebruikersbeheer — 13 oktober 2026

De gebruiker gaf expliciet toestemming om de aanvullende migratie en Edge Function in het bestaande project te installeren. Dit geeft nog geen toestemming voor het publiceren van de website, mergen of het wijzigen van bestaande accounts.

## Uitgevoerd

- Project: `hulpdienst-materiaalbeheer`, ref `qmhzollowjbarzbnibdf`.
- Vooraf een lokale herstelkopie gemaakt van alle dertien bestaande `material_private`-tabellen en de tien functiedefinities. Dit is een applicatiekopie in de werkomgeving, geen volledige Supabase-back-up van Auth/Storage en geen gegarandeerd permanente disaster-recoverykopie.
- Bestaande voorraadfunctie vergeleken met de beoordeelde safeupdate-migratie: inhoud gelijk na normalisatie van Windows-regeleinden. Geen externe databaseviews of foreign keys gevonden die van het private schema afhangen. Dit sluit externe REST-clients niet uit; de oude publieke tabellen zijn ongemoeid gelaten.
- `20261013170914_user_management.sql` transactioneel geïnstalleerd via Supabase migration API, naam `user_management`.
- Edge Function `user-management` versie 2 actief. Origin: `https://polite-conkies-1226e4.netlify.app`. De verplichte Supabase-servervariabelen worden door het platform geleverd; geen geheime sleutel naar de browser gekopieerd.
- De website niet gepubliceerd; PR #1 en main niet gewijzigd. De gekoppelde Netlify-integratie kan automatisch PR-previews maken.

## ES256 en tokencontrole

Het project adverteert ES256-signing keys. De [Supabase-documentatie](https://supabase.com/docs/guides/auth/signing-keys) vermeldt dat de legacy Edge-gatewaycontrole met deze signing keys incompatibel is. Daarom is uitsluitend voor `user-management` de legacy `verify_jwt`-instelling uitgeschakeld. De handler verifieert ieder persoonlijk token via Auth `getUser` voordat hij een beheeractie uitvoert. SQL controleert daarnaast actief lidmaatschap, adminrol en sessie. Anonieme of ongeldige tokens worden geweigerd. RLS en databasegrants zijn niet uitgeschakeld.

## Verificatie op het bestaande project

- Vergelijking vóór/na: alle bestaande applicatiegegevens gelijk, afgezien van de nieuwe status-/datumkolommen op leden. Auth-accountfingerprint gelijk; één bestaand account. Geen nieuwe accounts, uitnodigingen of beheeracties aangemaakt.
- Voorraad: totaal 15; historiek: 14 mutaties; revisie: 14. Deze waarden zijn door de installatie niet gewijzigd.
- Directory-RPC en bestaande voorraad-RPC getest onder `authenticated` met de databaseclaims van een bestaande geldige adminsessie, binnen een teruggedraaide transactie: adminrol behouden, directory bevat één lid. Dit is een databasecontrole, geen end-to-end browserlogin.
- Nieuwe private tabellen niet rechtstreeks leesbaar of schrijfbaar voor anon, authenticated of service_role. Anon heeft geen uitnodigings-, directory- of acceptatierechten. Alleen service_role mag verzendregistratie afronden.
- Edge-runtime: CORS-preflight 204, anoniem 401, ongeldig token 401 via Auth-verificatie, verkeerde origin 403. Geen accountinformatie teruggegeven.
- Security advisor: geen nieuwe ERROR-waarschuwingen. Informatieve RLS-zonder-policy-meldingen voor het private schema zijn verwacht: tabellen zijn gesloten en alleen gecontroleerde RPC's geven toegang. Bestaande waarschuwing: leaked-password protection staat uit; die projectbrede Auth-instelling is niet gewijzigd. [Supabase-uitleg](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## Nog vóór ingebruikname

Publiceer pas na afzonderlijke toestemming de websiteversie uit PR #3. Daarna verschijnt Instellingen → Gebruikersbeheer. Controleer de Auth-redirectallowlist, uitnodigingsmailtemplate, SMTP en e-mail-OTP-vervalduur in het Supabase-dashboard volgens de [handleiding](GEBRUIKERSBEHEER.md); deze projectbrede instellingen konden via de beschikbare connector niet worden bekeken of gewijzigd. Een verkeerde redirectallowlist kan het acceptatiepad uit de uitnodigingslink verwijderen.

Echte uitnodiging, bevestigde admin-Edge-aanvraag met een persoonlijk browsertoken, acceptatie en resend moeten nog doorlopen worden met een afgesproken nieuw testadres. Er zijn geen e-mails verstuurd en er is niet aan bestaande accounts gekomen. De lokale integratietests controleren die flows met fictieve Auth HTTP-antwoorden en echte PostgreSQL-RPC's.
