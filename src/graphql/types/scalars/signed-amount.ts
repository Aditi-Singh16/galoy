import { GT } from "@graphql/index"

const SignedAmount = new GT.Scalar({
  name: "SignedAmount",
  parseValue(value) {
    return validSignedAmount(value)
  },
  parseLiteral(ast) {
    if (ast.kind === GT.Kind.INT) {
      return validSignedAmount(ast.value)
    }
    return new Error("Invalid type for SignedAmount")
  },
})

function validSignedAmount(value) {
  if (Number.isInteger(value)) {
    return value
  }
  return new Error("Invalid value for SignedAmount")
}

export default SignedAmount
