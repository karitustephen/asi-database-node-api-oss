@description('The Azure region for deployment.')
param location string = resourceGroup().location

@description('Application name used in resource naming.')
param appName string = 'asi-db-api'

resource appPlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: '${appName}-plan'
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

output appPlanName string = appPlan.name
output appLocation string = location
