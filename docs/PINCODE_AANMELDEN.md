# Persoonlijke pincode als volledige vervanging

De gebruiker heeft gekozen voor een persoonlijke pincode van **4 tot en met 8 cijfers**, in plaats van een zelfgekozen wachtwoord. Dit is een PIN voor ieder persoonlijk account; aanmelden blijft met e-mailadres plus pincode. Een gedeeld websiteadres vervangt geen toegangscontrole.

Deze uitbreiding is voorbereid op `codex/pincode-aanmelden`. Zij is nog niet op productie geïnstalleerd of gepubliceerd. Er zijn geen bestaande accounts, wachtwoorden, rollen, voorraadrecords of e-mails automatisch gewijzigd.

## Gebruik

- **Nieuwe uitnodiging:** open de nieuwste mail en vul tweemaal je gekozen pincode in. Voorloopnullen zoals `0042` blijven behouden. Alleen een bevestigde, nog geldige uitnodiging voor het eigen account kan worden geactiveerd. Het account krijgt zoals voorheen de rol vrijwilliger; een beheerder kan daarna expliciet de rol aanpassen.
- **Aanmelden:** gebruik je persoonlijke e-mailadres en pincode. De pincode wordt op het toestel niet opgeslagen. Sluiten of afmelden beëindigt de lokale sessie volgens de bestaande geheugenopslag.
- **Bestaande gebruiker:** kies voorlopig **Aanmelden met bestaand wachtwoord**, meld persoonlijk aan en open **Mijn account**. Stel daar je eigen PIN in en bevestig de vervanging. De installatie voert deze stap niet automatisch uit. Als hetzelfde Auth-account elders gebruikt wordt, verandert ook daar het wachtwoord; controleer dat vóór overstappen.
- **Wijzigen:** via **Mijn account**. De oorspronkelijke aanmelding moet minder dan 15 minuten oud zijn; meld zo nodig opnieuw aan.
- **Vergeten:** kies **Pincode vergeten?**. Een herstelmail naar het eigen adres geeft een nieuwe, recent geverifieerde sessie om de PIN te vervangen. Een nog niet geaccepteerde uitnodiging moet de beheerder opnieuw verzenden.
- **Te veel pogingen:** na vijf aanmeldpogingen zonder bevestigde succesvolle login is aanmelden voor dat adres 15 minuten begrensd. Ook een andere browser of een ander apparaat kan die servercontrole niet omzeilen. Een geslaagde login of geverifieerd herstel zet de teller terug. De bestaande applicatieblokkering blijft gelden.

Kies bij voorkeur acht cijfers, deel je PIN niet en vermijd herkenbare datums of codes. Vier cijfers blijven makkelijker te raden. De pogingenbegrenzing beschermt tegen online raden; zij maakt een korte PIN niet even sterk als een lang wachtwoord en voorkomt geen misbruik van een gedeelde of gestolen PIN.

## Serverwerking en gegevensbescherming

De browser gebruikt de nieuwe Edge Function **`pin-auth`**. Aanmelden is publiek bereikbaar, maar geeft pas na controle een persoonlijke Supabase-sessie. Instellen vereist een door Auth `getUser` geverifieerd JWT en SQL-controle op account, sessie, recency, actieve toegang of de eigen geldige uitnodiging. Gebruikersmetadata bepaalt nooit rechten. De service-role-sleutel blijft serverzijdig.

Een afzonderlijk, willekeurig servergeheim per gebruiker staat in de gesloten `material_private.pin_credentials`-tabel. De functie leidt via HMAC-SHA-256 een intern wachtwoord van 72 tekens af uit dat geheim, account-UUID en PIN. Supabase bewaart de normale bcrypt-hash van dat interne wachtwoord. De gekozen PIN zelf wordt niet opgeslagen of in querystrings gezet. Het geheim en interne wachtwoord worden niet naar de browser teruggegeven. De standaard Auth-wachtwoordeisen van het project worden niet verlaagd.

Hierdoor werkt het rechtstreeks aanbieden van de korte PIN aan de gewone Supabase-wachtwoord-API niet. Alleen de PIN-server kan het bijbehorende interne wachtwoord maken. Deze bescherming is afhankelijk van het geheimhouden van de per-user secrets en de server-/databasebeheersleutels. Een volledige databaseback-up bevat zulke secrets en vereist beperkte toegang; de bestaande voorraadexport bevat ze niet.

De SQL-budgetten tellen ook onbekende e-mailadressen en blijven bestaan bij verkeerde PINs, netwerkfouten en verschillende apparaten. Een tweede budget begrenst het hele PIN-aanmeldendpoint tot 120 pogingen per kwartier. Herstelmailaanvragen zijn afzonderlijk beperkt tot één per adres per kwartier en twintig projectaanvragen per uur; de eigen SMTP-/Supabase-limieten blijven daarnaast gelden. Reacties op onbekende of geweigerde hersteladressen zijn gelijk en beloven geen daadwerkelijk verstuurde mail. CORS is geen identiteitscontrole: de persoonlijke Auth- en SQL-controles en budgets blijven leidend.

Instellen, wijzigen en geslaagde PIN-logins worden zonder PIN of intern wachtwoord in de bestaande private toegangsaudit geregistreerd. Iedere mutatie richt zich uitsluitend op de geverifieerde gebruiker; een beheerder kan via deze API geen PIN van anderen kiezen of lezen. Rollen en voorraad worden niet door PIN-acties gewijzigd.

## Fouten en herstelbaarheid

Auth-wachtwoordwijziging en applicatie-SQL zijn afzonderlijke diensten en kunnen niet in één database-transactie worden uitgevoerd. Instellen reserveert daarom een request-ID en bewaart hetzelfde servergeheim. Parallelle wijzigingen worden tegengehouden. Een bevestigde herhaling controleert de betreffende PIN via Auth zonder nogmaals het wachtwoord of audit te wijzigen.

Na het instellen wordt een nieuwe Auth-sessie voor hetzelfde account verkregen: de oude sessie kan door een wachtwoordwijziging ongeldig zijn. De nieuwe sessie wordt aan SQL gebonden voordat opslag bevestigd wordt. Als Auth een reeds identiek wachtwoord meldt, is succesvolle aanmelding met exact de afgeleide credential alsnog vereist. Foutgevallen krijgen geen vals succesbericht.

Bij een verloren antwoord kan de credential al gewijzigd zijn. Blijf indien mogelijk aangemeld en herhaal dezelfde handeling; er wordt geen PIN in lokale opslag bewaard. Bij een nog onzekere eerdere aanvraag kan een nieuwe aanvraag vijf minuten geblokkeerd worden. Als de vorige sessie is vervallen, gebruik voor een actief account **Pincode vergeten?**, of laat bij een nieuwe uitnodiging de beheerder opnieuw verzenden. De tijdelijke reservering verloopt; zij veroorzaakt geen permanente accountverwijdering of voorraadverlies. Als de PIN al bevestigd is maar acceptatie/synchronisatie een antwoord verloor, herhaalt het scherm alleen de activeringscontrole en niet de PIN-opslag.

## Installatie na afzonderlijke productiegoedkeuring

1. Controleer andere toepassingen op hetzelfde Supabase-project. De SQL-installatie wijzigt geen Auth-account; de vrijwillige keuze om een PIN in te stellen vervangt wel het wachtwoord van dat persoonlijke account. Andere toepassingen met hetzelfde account moeten daarmee rekening houden.
2. Maak een gecontroleerde volledige back-up. Installeer na de bestaande v2-, safeupdate-, gebruikersbeheer- en rolmigraties **`supabase/migrations/20261013184510_pin_authentication.sql`**. Het bestand is transactioneel en opnieuw uitvoerbaar. Het maakt uitsluitend nieuwe private credential-/budgettabellen en beperkte RPCs; er worden geen bestaande accounts automatisch omgezet.
3. Deploy **`supabase/functions/pin-auth/index.ts`**, `handler.mjs` en `password.mjs`. De standaard Supabase-servervariabelen leveren project-URL, anon key en service-role key. De app-origin heeft dezelfde bestaande standaard als gebruikersbeheer, met de optionele `MATERIAL_APP_ORIGIN`-override. Geen nieuwe geheime sleutel in browsercode of GitHub zetten.
4. `verify_jwt=false` geldt voor deze functie: login is bewust nog niet aangemeld, terwijl instellen verplicht Auth-tokenverificatie en persoonlijke SQL-sessiecontrole uitvoert. RLS en private grants blijven actief. Loginhelpers en alle secrets zijn uitsluitend via service-role beschikbaar; een gewone aangemelde gebruiker krijgt alleen een bool voor diens eigen PIN-status.
5. Controleer [Auth → URL Configuration](https://supabase.com/dashboard/project/qmhzollowjbarzbnibdf/auth/url-configuration): Site URL blijft de bestaande website. Voeg zo nodig de exacte redirect **`https://polite-conkies-1226e4.netlify.app/?pin_reset=1`** toe naast de bestaande uitnodigingsredirects; verwijder geen andere adressen. De native uitnodigings- en herstelmail moeten `ConfirmationURL` behouden. Je kunt de herstelmailtekst/onderwerp in het dashboard aanpassen naar "Pincode herstellen". SMTP-, CAPTCHA-, wachtwoordbeleid en projectbrede instellingen worden door deze PR niet automatisch gewijzigd. Als native Auth CAPTCHA vereist, moet de brokerflow vóór ingebruikname daarop afgestemd worden.
6. Merge/publiceer uitsluitend na expliciete toestemming. Controleer dat Netlify de actuele goedgekeurde branch en `dist` gebruikt; main en herstelbranch moeten niet op verschillende productieversies blijven staan.
7. Test met afgesproken fictieve accounts: nieuwe uitnodiging, vier/acht cijfers en voorloopnul, login, vijf verkeerde pogingen vanaf meerdere apparaten, blokkering, eigen conversie en e-mailherstel. Test echt Android/Chrome en iPhone/Safari. Geen bestaande accounts omzetten zonder hun eigen expliciete keuze.

## Terugdraaien

Een mislukte SQL-installatie rolt de betreffende transactie terug. Na ingebruikname verwijdert het terugzetten van de oude website de PIN-server niet: reeds omgezette accounts kennen het interne wachtwoord niet. Bewaar daarom de PIN-login/-herstelroute zolang er omgezette gebruikers zijn. Zet een bestaande gebruiker alleen via een geverifieerde persoonlijke herstelactie terug naar een eigen wachtwoord, na toestemming. Verwijder geen credential-secrets, Auth-accounts, toegangsaudit of voorraad als noodoplossing.

## Testgrenzen

Resultaat op 13 oktober 2026: **76/76 automatische tests** en **23/23 browsertests geslaagd**. De productiebuild en bundelcontrole van de nieuwe Edge Function slagen. Er zijn geen afhankelijkheden toegevoegd.

Tests gebruiken PostgreSQL 17 met echte pg-safeupdate en fictieve accounts. Crypto, service-only rechten, idempotente installatie, sessie-/uitnodigingsbinding, counters en concurrency lopen tegen echte code/SQL. Browsertests simuleren Auth HTTP en SMTP; bij PIN-instellen worden de oude fake sessies expliciet ingetrokken om het strengere sessiescenario te testen. De fake Auth gebruikt een SHA-256-testdigest, geen echte GoTrue-bcrypt. Geen e-mails verstuurd of live accounts veranderd tijdens deze tests.

Echte Supabase-wachtwoordwijziging, native SMTP, CAPTCHA-/MFA-configuratie, Deno-gateway en fysieke mobiele apparaten moeten op een testproject of met afzonderlijk afgesproken testaccounts worden gecontroleerd vóór brede ingebruikname. Bij database- of servercompromis blijven korte PINs zwakker: online-budgetten beschermen geen gestolen volledige databasekopie.
