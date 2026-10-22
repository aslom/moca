//go:build unix

// Command moca-egress is the host-side forward proxy for microVM guests.
// Config comes from MOCA_EGRESS_* environment variables; audit JSON goes to
// stdout and logs to stderr.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/rossoctl/moca/remote-worker/internal/egress"
	"github.com/rossoctl/moca/remote-worker/internal/egress/control"
)

func main() {
	cfg, cc, err := egress.ConfigFromEnv(os.Getenv)
	if err != nil {
		log.Fatalf("moca-egress: %v", err)
	}
	proxy, err := egress.NewProxy(cfg)
	if err != nil {
		log.Fatalf("moca-egress: %v", err)
	}
	srv, err := control.NewServer(cc.Socket, cc.AllowedUIDs, proxy)
	if err != nil {
		proxy.Close()
		log.Fatalf("moca-egress: control socket %s: %v", cc.Socket, err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve() }()
	log.Printf("moca-egress: serving %d allowlist entries, control socket %s", len(cfg.Allow), cc.Socket)

	select {
	case <-ctx.Done():
		srv.Close()
		<-serveErr
		proxy.Close()
	case err := <-serveErr:
		if err != nil {
			log.Printf("moca-egress: control server: %v", err)
			proxy.Close()
			os.Exit(1)
		}
		proxy.Close()
	}
}
