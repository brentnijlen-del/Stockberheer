Hulpdienst Materiaalbeheer – Afdeling Nijlen

Deze versie gebruikt persoonlijke Supabase-accounts. Gedeelde toegangscodes en
beheerders-PINs zijn verwijderd. Publiceer pas na het instellen van Supabase.

1. Maak eerst een back-up van de bestaande app_state-tabel in Supabase.
2. Controleer en voer supabase/security.sql uit in de SQL Editor.
   Dit vervangt bestaande toegangsregels voor app_state en app_members.
3. Zet publieke registratie uit: Authentication > instellingen > Allow new users
   to sign up uitschakelen. Gebruik persoonlijke accounts via Add user.
4. Voeg elk goedgekeurd account toe aan app_members: user_id is de UUID uit
   Authentication > Users; role is admin of volunteer. Rollen worden uitsluitend
   via Supabase beheerd. Deel nooit een service_role- of geheime sleutel.
5. Meld eerst aan als beheerder. Bij een lege database: maak een product aan om
   de inventaris te initialiseren. Bij bestaande data: sla als beheerder een
   wijziging op; dit verwijdert de oude PIN en gebruikersmodus uit de clouddata.
6. Test met beheerder, vrijwilliger en een account zonder lidmaatschap.
   Anonieme aanvragen mogen geen voorraad kunnen lezen of schrijven.
7. Upload index.html naar de bestaande HTTPS Netlify-site nadat deze checks slagen.

Vrijwilligers kunnen voorraadbewegingen, tekorten en uitleningen wijzigen.
De database beschermt catalogus en configuratie tegen vrijwilligerswijzigingen.
Vrijwilligers delen operationele gegevens; dit is geen bescherming van individuele
records tegen andere vrijwilligers. De JSON-opslag is geen onveranderbaar auditlog.
Gelijktijdige wijzigingen worden geweigerd in plaats van stil overschreven.
Bij een opslagfout meldt de app af: de wijziging is NIET opgeslagen.
Sessies blijven alleen in het geheugen; herladen vraagt opnieuw aanmelden.

Lokale controle: node --test tests/auth.test.cjs
Voor lokaal openen: python3 -m http.server 8000 (in deze map).
De browser heeft internet nodig voor Supabase en de QR-scannerbibliotheek.
De publishable Supabase-sleutel is bedoeld voor de browser. Databasebeleid
bepaalt de toegang; verberg deze sleutel niet als vervanging voor toegangsregels.
