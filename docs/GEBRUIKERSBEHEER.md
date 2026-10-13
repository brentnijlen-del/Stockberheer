# Gebruikersbeheer — issue #2

Deze uitbreiding staat op `codex/gebruikersbeheer`, gebaseerd op `codex/volledig-herstel`. PR #1 en `main` worden niet gewijzigd. Er is geen SQL op productie uitgevoerd, geen functie of website gepubliceerd en geen echte uitnodiging verzonden.

## Wat de beheerder ziet

Ga naar **Instellingen → Gebruikersbeheer**. Je ziet e-mailadres, rol, status en uitnodigings- of activatiedatum. Voor bestaande leden is de vroegere activatiedatum niet bekend; het scherm vermeldt dat eerlijk. Alleen beheerders kunnen dit overzicht opvragen.

Vul een e-mailadres in en kies **Vrijwilliger uitnodigen**. De ontvanger opent de e-mail en stelt een persoonlijk wachtwoord van minstens twaalf tekens in. Pas na geldige acceptatie krijgt die persoon toegang als vrijwilliger. Vrijwilligers kunnen hun bestaande voorraadhandelingen uitvoeren, maar geen catalogus of gebruikers beheren.

Een link geldt één uur. **Opnieuw verzenden** kan na één minuut en hergebruikt hetzelfde uitgenodigde account. Een bestaande, niet via deze uitnodiging aangemaakte Auth-gebruiker wordt geweigerd; neem daarvoor contact op met de projectbeheerder. Beheerders uitnodigen of rollen wijzigen is bewust niet beschikbaar in dit scherm.

**Blokkeren** stopt onmiddellijk de toegang tot deze toepassing, ook bij directe RPC-aanvragen met een nog geldig token. Het account, de voorraad en historiek blijven bestaan. **Heractiveren** geeft de bestaande rol terug. Je kunt je eigen toegang niet wijzigen en er moet minstens één actieve beheerder blijven. Dit is een applicatieblokkering: andere toepassingen op hetzelfde Supabase-project krijgen geen Auth-ban opgelegd.

## Installatie — uitsluitend na afzonderlijke toestemming

1. Laat deze PR en de onderstaande migratie beoordelen. Maak een volledige databaseback-up en controleer welke andere toepassingen `material_private`, de ledenfunctie of `public.material_*` gebruiken. De migratie wijzigt geen oude publieke tabellen en sluit hun toegang niet af.
2. Test eerst op een afzonderlijk Supabase-testproject met fictieve gegevens. De npm-testbootstrap is uitsluitend voor de lokale testdatabase; voer die nooit op Supabase of productie uit.
3. Installeer, na de bestaande v2- en safeupdate-migraties, **`supabase/migrations/20261013170914_user_management.sql`**. Het bestand is transactioneel en opnieuw uitvoerbaar. Het voegt status/activatiedatum aan leden toe, maakt uitnodigingen en toegangsaudit aan en vervangt de ledencontrole en voorraadfunctie. Bestaande rollen en accounts blijven bestaan; bestaande leden zijn aanvankelijk actief. De vervanging van de voorraadfunctie behoudt alle safeupdate-WHERE-clausules en controleert toegang opnieuw na de transactielock.
4. Configureer Supabase Auth: de juiste website-URL en toegestane redirect naar `https://<website>/?invitation=*`, werkende SMTP en een uitnodigingse-mail die de native `ConfirmationURL` gebruikt. Stel de e-mail-OTP-vervalduur in op maximaal 3600 seconden. De SQL controleert daarnaast zelf één uur geldigheid en weigert een sessie die ouder is dan de nieuwste verzending. Laat open publieke registratie uit als die niet nodig is.
5. Configureer de Edge Function `user-management` met **`MATERIAL_APP_ORIGIN=https://<website>`** (exacte origin, zonder pad). `SUPABASE_URL`, `SUPABASE_ANON_KEY` en `SUPABASE_SERVICE_ROLE_KEY` zijn servervariabelen. De service-role-sleutel mag nooit in Netlify-buildvariabelen, browsercode of een publiek bestand terechtkomen. Behoud `verify_jwt = true` in `supabase/config.toml`. De functie controleert het token aanvullend via Auth `getUser` en laat SQL de actieve adminrol controleren.
6. Deploy de Edge Function en website uitsluitend na expliciete goedkeuring, met de bestaande publieke browserconfiguratie. De functie gebruikt een beheersleutel alleen om een nieuwe uitnodiging te verzenden en het resultaat vast te leggen; ledenbeheer loopt onder het persoonlijke JWT van de beheerder.
7. Controleer echte e-mailbezorging, acceptatie, vervaldatum, resend, wachtwoordbeleid, blokkeren en heractiveren met afgesproken testaccounts. Test Android/Chrome en iPhone/Safari. Controleer dat anoniem, niet-leden en vrijwilligers geen directory krijgen en dat blokkering voorraad-RPC's meteen stopt. Bestaande accounts wijzigen is geen onderdeel van deze installatie.

## Veilig terugdraaien

Bij een fout tijdens SQL-installatie rolt de transactie volledig terug. Na een geslaagde installatie kun je de vorige website terugzetten en de Edge Function uitschakelen. Bewaar de nieuwe tabellen en audit, de statuskolom en de vernieuwde `member_role`/voorraadcontroles: die zorgen ervoor dat geblokkeerde gebruikers geblokkeerd blijven. Installeer de oudere ledenfunctie niet opnieuw als noodoplossing, want die negeert blokkeringen. Een volledige database-rollback vereist afzonderlijke beoordeling van inmiddels geaccepteerde uitnodigingen en blokkeringen; verwijder geen Auth-accounts of voorraad.

## Beveiliging en beperkingen

Uitnodigingen geven uitsluitend de rol `volunteer`. De database bindt ze aan het nieuwe account, e-mailadres, oorspronkelijke aanvraag en een geldige persoonlijke sessie. Tabellen met e-mails en toegangsaudit hebben RLS en geen directe clientrechten. De directory retourneert uitsluitend expliciete schermvelden, geen tokens of wachtwoorden. Persoonsgegevens worden escaped voordat de interface ze toont. URL-tokens worden meteen verwijderd en sessies blijven in geheugen.

Verzending is begrensd tot twintig aanvragen per beheerder per vijftien minuten en één resend per adres per minuut. Een verloren verzendantwoord kan onzeker zijn; het scherm meldt dit en stelt een nieuwe verzending voor. Er wordt geen voorraadwijziging of toegang toegekend op basis van alleen een verzendbevestiging. Een bevestigde, nog niet geaccepteerde uitnodiging wordt opnieuw verzonden via Auth recovery; alleen het aantoonbaar door deze uitnodiging aangemaakte account komt hiervoor in aanmerking. Supabase bepaalt daarnaast eigen mailquota en tokenintrekking.

Toegangsaudit staat in `material_private.user_events`; alleen de projectbeheerder kan die serverzijdig inspecteren. De bestaande voorraadback-up is geen back-up van Auth, uitnodigingen of toegangsaudit; daarvoor is een volledige Supabase-back-up nodig. Bepaal bewaartermijnen voor e-mailadressen en audit met de afdeling.

## Testen

Resultaat op 13 oktober 2026: `npm test` **58/58 geslaagd**, `npm run test:browser` **15/15 geslaagd**, productiebuild geslaagd, Edge-entrypoint bundelt met esbuild en `npm audit --omit=dev --audit-level=moderate` vindt **0 kwetsbaarheden**. De extra schermtest controleert gebruikersbeheer op 320, 390, 768 en 1440 pixels. Een bundelcheck is geen test van de echte Deno-runtime.

De tests gebruiken PostgreSQL 17 met de echte `pg-safeupdate`-module en fictieve Auth-gebruikers. Ze controleren admin/vrijwilliger/niet-lid/anoniem, private tabelrechten, uitnodigingsbinding, vervaldatum, resend zonder tweede account, verse sessie na resend, acceptatie, rolbeperkingen, blokkering, behoud van account/voorraad en een reeds wachtend voorraadverzoek. De migratie wordt opnieuw toegepast om idempotentie te controleren.

De browseradapter simuleert uitsluitend Auth HTTP, mailbezorging en e-mailbevestiging. Directory, uitnodigingsregistratie, acceptatie en voorraad-RPC's lopen tegen de echte lokale database. De Edge-handler wordt met geïnjecteerde clients getest op tokencontrole, CORS, weigering vóór verzending, server-only sleutels en netwerk-/verzendfouten.

Echte Supabase-mailbezorging, GoTrue-tokenverificatie, Edge-gateway/Deno-runtime en fysieke mobiele apparaten zijn niet end-to-end getest. Die controles moeten op een testproject plaatsvinden vóór productie-installatie. De lokale tests versturen geen e-mail.
