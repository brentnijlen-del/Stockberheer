# Rollen kiezen en uitnodigingslinks herstellen

## Vastgestelde uitnodigingsfout

Op 13 oktober 2026 is bevestigd dat Supabase een redirect naar de gepubliceerde website weigert en terugvalt op `http://localhost:3000`. De controle gebruikte een verzonnen, ongeldige verificatietoken; er is geen echte link geopend, mail verstuurd of account gewijzigd. Zowel het websiteadres als het adres met `?invitation=...` gaf een 303-redirect naar localhost.

De bestaande uitnodiging is wel verzonden en bij de eerste klik door Auth bevestigd. De ontvanger kreeg toen een sessie, maar kwam door de verkeerde redirect niet op de website terecht. Een volgende klik gaf in de Auth-logs `One-time token not found`. De vrijwilliger heeft nog geen applicatielidmaatschap: de acceptatie in de website is niet voltooid.

### Herstel in het Supabase-dashboard

Open [Authentication → URL Configuration](https://supabase.com/dashboard/project/qmhzollowjbarzbnibdf/auth/url-configuration).

**Site URL:**

```text
https://polite-conkies-1226e4.netlify.app
```

Voeg bij **Redirect URLs** de volgende twee adressen toe. Laat bestaande adressen staan zodat andere toepassingen hun redirects behouden.

```text
https://polite-conkies-1226e4.netlify.app/
https://polite-conkies-1226e4.netlify.app/?invitation=*
```

De Site URL is projectbreed en verandert de standaardbestemming voor bevestigings- en herstelmails. Controleer bij een gedeeld project welke andere toepassingen die standaard gebruiken. Sla op, kies in Gebruikersbeheer **Opnieuw verzenden** en open uitsluitend de nieuwste mail. Een bevestigde maar nog niet geaccepteerde uitnodiging gebruikt recovery voor hetzelfde account; er wordt geen tweede account aangemaakt.

Deze Auth-configuratie is niet via de beschikbare connector te lezen of aan te passen. Er is daarom geen projectbrede instelling automatisch gewijzigd. De nieuwe interface toont een duidelijke fout wanneer Auth een verlopen link meldt of de invitation-parameter ontbreekt, en verwijdert URL-tokens onmiddellijk. De localhost-bestemming zelf moet in het dashboard worden gecorrigeerd.

## Nieuwe keuze: beheerder of vrijwilliger

Na installatie van deze uitbreiding verschijnt bij andere **actieve** gebruikers een keuze **Gebruikersrol → Vrijwilliger / Beheerder** en **Rol opslaan**. Bij een beheerder wordt expliciet gewaarschuwd dat alle beheerfuncties beschikbaar worden; bij vrijwilliger dat beheerrechten verdwijnen. De actie vraagt bevestiging.

Nieuwe uitnodigingen blijven standaard vrijwilliger. De ontvanger accepteert eerst de uitnodiging. Daarna kan een beheerder de rol aanpassen. Een geblokkeerde gebruiker moet eerst expliciet worden geheractiveerd; een rolwijziging heractiveert niemand automatisch. Je eigen rol is niet wijzigbaar. Servercontroles voorkomen dat alle actieve beheerders door gelijktijdige acties hun beheerrechten verliezen.

Vrijwilligers kunnen hun bestaande verbruik-, koffercontrole-, tekort- en uitleenhandelingen uitvoeren. Beheerders hebben ook catalogus-, voorraad- en gebruikersbeheer. Deze uitbreiding voegt geen afzonderlijke rechten per handeling toe.

## Installatie na afzonderlijke goedkeuring

1. Beoordeel `supabase/migrations/20261013181457_member_role_management.sql`. Maak een herstelkopie volgens de bestaande installatiehandleiding. De migratie maakt een nieuwe gecontroleerde role-RPC en twee nullable auditkolommen. Zij is transactioneel en opnieuw uitvoerbaar; zij wijzigt geen bestaande rollen, Auth-accounts of voorraadrecords en raakt de oude publieke tabellen niet.
2. Installeer de migratie in het bestaande project na expliciete toestemming. Alle nieuwe clientrechten beperken zich tot de RPC; private tabellen blijven gesloten.
3. Deploy de bijgewerkte `user-management` Edge Function met de bestaande serverconfiguratie. Elke rolwijziging gebruikt het persoonlijke JWT, Auth `getUser` en actieve SQL-admin-/sessiecontrole. De beheersleutel wordt niet gebruikt om rollen te wijzigen.
4. Publiceer de goedgekeurde websitewijziging via GitHub → main → Netlify. Deze branch/PR wordt niet automatisch gemerged.
5. Controleer met afgesproken accounts uitnodiging en acceptatie, daarna vrijwilliger → beheerder → vrijwilliger. Voer geen rolwijziging uit op een bestaand account zonder toestemming van de beheerder. Acties worden met actor, doel, oude rol en nieuwe rol in `material_private.user_events` geregistreerd.

Een reeds aangemelde gebruiker krijgt de nieuwe rol bij de volgende snapshot. Bij demotie weigert SQL beheeracties onmiddellijk, ook met het oude token en bij wachtende voorraadcommando's. De interface meldt een rolverandering en vraagt opnieuw aanmelden. Een onzekere netwerkuitkomst wordt niet als opgeslagen gemeld: ververs het overzicht om de werkelijke rol te zien.

## Veilig terugdraaien

Bij een SQL-installatiefout wordt de transactie teruggedraaid. Na installatie kun je de vorige website en Edge Function terugzetten zodat de rolkeuze verdwijnt. Bewaar de auditkolommen en de leden-/statuscontrole. Een reeds door een beheerder gekozen rol wordt niet automatisch teruggedraaid; behandel dat als een afzonderlijke, expliciete gebruikersbeheeractie. Verwijder geen accounts of auditgeschiedenis.

## Validatie

Op 13 oktober 2026: **62/62 automatische tests geslaagd** en **18/18 browsertests geslaagd**. De productiebuild en Edge-entrypoint-bundelcheck slagen. De browsertests gebruiken Chromium op desktop- en mobiele vensterformaten, geen fysieke Android- of iPhone-apparaten.

Tests gebruiken de afgeschermde lokale PostgreSQL 17-database met echte pg-safeupdate en fictieve accounts. Role-RPC's en browserhandelingen lopen tegen echte SQL. Auth HTTP en e-mail zijn lokaal gesimuleerd. Gedekt: admin/vrijwilliger/niet-lid/anoniem, ongeldige rollen, zelfwijziging, niet-geaccepteerde en geblokkeerde accounts, stale wijzigingen, veilige retry, voor/na-audit, behoud Auth/voorraad, directe API-weigering na demotie en twee beheerders die elkaar gelijktijdig proberen te demoveren. Browserchecks controleren expliciete bevestiging, gewijzigde toegang, onzeker netwerkantwoord, mobiele schermen en foutmeldingen bij onvolledige/verlopen redirects.

De echte mailflow kan pas opnieuw worden getest na de dashboardcorrectie. Deze PR wijzigt nog geen live rollen en verstuurt geen e-mails.
