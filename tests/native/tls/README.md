# Native TLS test certificates

These public test fixtures come from PostgreSQL 18.7's `src/test/ssl/ssl/` directory under the PostgreSQL licence.
The test server presents the certificate chain for `common-name.pg-ssltest.test`.
`root_ca.crt` trusts that chain and `client_ca.crt` exercises rejection by an unrelated trust anchor.
The server key is publicly known and belongs only in disposable test clusters.
