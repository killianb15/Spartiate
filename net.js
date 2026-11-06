// =====================================================================
//  Transport des paquets de jeu entre les deux joueurs.
//
//  Le WebSocket (via serveur.py) sert toujours à faire se rencontrer les joueurs et à
//  échanger la signalisation WebRTC. Dès que possible, une connexion directe
//  navigateur à navigateur (RTCDataChannel non fiable et non ordonné : comportement
//  d'UDP) prend le relais pour les entrées du jeu, ce qui évite le serveur et l'attente
//  des retransmissions TCP. Si WebRTC est indisponible, bloqué par un pare-feu ou
//  coupé en cours de partie, les paquets repartent automatiquement par le WebSocket.
// =====================================================================
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

export class Link {
  // wsSend(obj) : envoie par le WebSocket (fiable) ; onMessage(obj) : paquet reçu par n'importe quel canal
  constructor({ initiator, wsSend, onMessage, onState = () => {} }) {
    this.initiator = initiator; this.wsSend = wsSend; this.onMessage = onMessage; this.onState = onState;
    this.pc = null; this.dc = null; this.queue = []; this.hasRemote = false; this.closed = false;
    this.state = 'ws';                 // 'ws' (relais serveur) | 'rtc' (direct)
    this.start();
  }

  start() {
    if (typeof RTCPeerConnection === 'undefined') return;
    try {
      this.pc = new RTCPeerConnection({ iceServers: STUN });
    } catch (e) { this.pc = null; return; }
    const pc = this.pc;
    pc.onicecandidate = (e) => { if (e.candidate && !this.closed) this.wsSend({ t: 'rtc', ice: e.candidate }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.setState('ws'); };
    if (this.initiator) {
      this.setupChannel(pc.createDataChannel('jeu', { ordered: false, maxRetransmits: 0 }));
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .then(() => this.wsSend({ t: 'rtc', sdp: pc.localDescription }))
        .catch(() => this.setState('ws'));
    } else pc.ondatachannel = (e) => this.setupChannel(e.channel);
  }

  setupChannel(dc) {
    this.dc = dc;
    dc.onopen = () => this.setState('rtc');
    dc.onclose = () => this.setState('ws');
    dc.onerror = () => this.setState('ws');
    dc.onmessage = (e) => {
      try { this.onMessage(JSON.parse(e.data)); } catch (err) { /* paquet illisible : ignoré */ }
    };
  }

  setState(s) {
    if (this.closed || s === this.state) return;
    this.state = s;
    this.onState(s);
  }

  // message de signalisation reçu de l'adversaire via le serveur : { sdp } ou { ice }
  async signal(m) {
    const pc = this.pc;
    if (!pc || this.closed) return;
    try {
      if (m.sdp) {
        await pc.setRemoteDescription(m.sdp);
        this.hasRemote = true;
        if (m.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.wsSend({ t: 'rtc', sdp: pc.localDescription });
        }
        for (const c of this.queue.splice(0)) await pc.addIceCandidate(c);
      } else if (m.ice) {
        if (this.hasRemote) await pc.addIceCandidate(m.ice); else this.queue.push(m.ice);
      }
    } catch (e) { this.setState('ws'); }
  }

  // reliable=false : paquets d'entrées (tolèrent la perte) ; true : à ne pas perdre (resynchronisation)
  send(msg, reliable) {
    if (!reliable && this.dc && this.dc.readyState === 'open') {
      try { this.dc.send(JSON.stringify(msg)); return; } catch (e) { /* repli ci-dessous */ }
    }
    this.wsSend(msg);
  }

  close() {
    this.closed = true;
    try { this.dc?.close(); } catch (e) { /* déjà fermé */ }
    try { this.pc?.close(); } catch (e) { /* déjà fermé */ }
    this.dc = this.pc = null;
  }
}
