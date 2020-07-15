helm install --namespace=$NAMESPACE bitcoind -f ../../bitcoind-chart/regtest-values.yaml ../../bitcoind-chart/
helm install --namespace=$NAMESPACE mongodb --set auth.username=testGaloy,auth.password=testGaloy,auth.database=galoy,persistence.enabled=false bitnami/mongodb

kubectl wait --for=condition=ready pod -l app=bitcoind-container

helm install --namespace=$NAMESPACE lnd -f ../../lnd-chart/regtest-values.yaml ../../lnd-chart/

kubectl wait --for=condition=ready pod -l app=lnd-container
# kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=mongodb
