import gql from 'graphql-tag'

export default function readPersons () {
  return {
    query: gql`
      query MyQuery {
        persons (order_by: {persons_publications_aggregate: {count: desc}}){
          id
          given_name
          family_name
          start_date
          end_date
          semantic_scholar_id
          institution {
            name
          }
          persons_namevariances {
            id
            given_name
            family_name
          }
          persons_publications_aggregate {
            aggregate {
              count
            }
          }
        }
      }
    `
  }
}
