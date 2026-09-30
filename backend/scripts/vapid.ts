/** Erzeugt ein VAPID-Schlüsselpaar für Push-Nachrichten. Die Ausgabe in /etc/smartshift.env eintragen (privaten Schlüssel geheim halten!). */
import webpush from 'web-push';
const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\nVAPID_SUBJECT=mailto:admin@gastroevolution.de`);
